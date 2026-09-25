import dns from 'node:dns/promises';
import net from 'node:net';
import { AppError } from './errors.js';

function isIpv4Private(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const a = parts[0]!;
  const b = parts[1]!;
  const c = parts[2]!;
  const d = parts[3]!;
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
    || d === 255
  );
}

function isIpv6Private(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('ff')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped?.[1] ? isIpv4Private(mapped[1]) : false;
}

function isLoopback(address: string): boolean {
  return address === '::1' || address.toLowerCase().startsWith('127.');
}

export interface UrlPolicyOptions {
  allowPrivateNetworks: boolean;
  allowedHosts: string[];
  lookup?: typeof dns.lookup;
}

export class UrlPolicy {
  private readonly allowPrivateNetworks: boolean;
  private readonly allowedHosts: string[];
  private readonly lookup: typeof dns.lookup;
  private readonly cache = new Map<string, Promise<string[]>>();

  constructor(options: UrlPolicyOptions) {
    this.allowPrivateNetworks = options.allowPrivateNetworks;
    this.allowedHosts = options.allowedHosts.map((host) => host.toLowerCase());
    this.lookup = options.lookup ?? dns.lookup;
  }

  async assertNavigable(rawUrl: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new AppError(400, 'INVALID_URL', 'The URL is not valid.');
    }
    if (url.protocol === 'about:' && url.pathname === 'blank') return url;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AppError(400, 'URL_PROTOCOL_BLOCKED', 'Only http and https navigation is allowed.');
    }
    if (url.username || url.password) {
      throw new AppError(400, 'URL_CREDENTIALS_BLOCKED', 'URLs containing embedded credentials are blocked.');
    }
    await this.assertHost(url.hostname);
    return url;
  }

  async assertRequest(rawUrl: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new AppError(400, 'INVALID_URL', 'The request URL is not valid.');
    }
    if (url.protocol === 'about:' && url.hostname === 'blank') return;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AppError(400, 'URL_PROTOCOL_BLOCKED', 'This URL protocol is blocked.');
    }
    if (url.username || url.password) {
      throw new AppError(400, 'URL_CREDENTIALS_BLOCKED', 'URLs containing embedded credentials are blocked.');
    }
    await this.assertHost(url.hostname);
  }

  private async assertHost(hostname: string): Promise<void> {
    const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
    if (this.allowedHosts.length) {
      const explicitlyAllowed = this.allowedHosts.some((allowed) => (
        allowed === host || (allowed.startsWith('*.') && host.endsWith(allowed.slice(1)))
      ));
      if (explicitlyAllowed) return;
      throw new AppError(403, 'NETWORK_HOST_NOT_ALLOWED', 'The destination host is not in the configured allowlist.');
    }

    if (net.isIP(host)) {
      if (this.isBlockedAddress(host)) {
        throw new AppError(403, 'NETWORK_ADDRESS_BLOCKED', 'Private and link-local network addresses are blocked.');
      }
      return;
    }
    if (host === 'localhost' || host.endsWith('.localhost')) {
      if (!this.allowPrivateNetworks) {
        throw new AppError(403, 'NETWORK_ADDRESS_BLOCKED', 'Private and link-local network addresses are blocked.');
      }
      return;
    }

    let addresses: string[];
    try {
      addresses = await this.resolve(host);
    } catch {
      throw new AppError(403, 'NETWORK_NAME_UNRESOLVED', 'The destination hostname could not be resolved.');
    }
    if (addresses.some((address) => this.isBlockedAddress(address))) {
      throw new AppError(403, 'NETWORK_ADDRESS_BLOCKED', 'Private and link-local network addresses are blocked.');
    }
  }

  private isBlockedAddress(address: string): boolean {
    if (this.allowPrivateNetworks) return false;
    if (isLoopback(address)) return true;
    if (net.isIP(address) === 4) return isIpv4Private(address);
    return isIpv6Private(address);
  }

  private resolve(host: string): Promise<string[]> {
    const cached = this.cache.get(host);
    if (cached) return cached;
    const result = this.lookup(host, { all: true, verbatim: true }).then((entries) => entries.map((entry) => entry.address));
    this.cache.set(host, result);
    return result;
  }
}
