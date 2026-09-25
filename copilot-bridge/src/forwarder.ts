import { browserApiBaseUrl, type BridgeConfig } from './config.js';
import type { BridgeEndpoint } from './contracts.js';
import { BridgeError } from './errors.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ForwardContext {
  sessionId?: string;
  permissionToken?: string;
  approvalSecret?: string;
}

export interface ForwardResult {
  status: number;
  body: string;
  contentType?: string;
}

interface RouteDefinition {
  method: 'GET' | 'POST';
  path: string;
}

const ROUTES: Record<BridgeEndpoint, RouteDefinition> = {
  'browser.session.start': { method: 'POST', path: '/browser/session/start' },
  'browser.session.end': { method: 'POST', path: '/browser/session/end' },
  'browser.dom': { method: 'GET', path: '/browser/dom' },
  'browser.query': { method: 'POST', path: '/browser/query' },
  'browser.action': { method: 'POST', path: '/browser/action' },
  'browser.eval': { method: 'POST', path: '/browser/eval' },
  'browser.workflow': { method: 'POST', path: '/browser/workflow' },
  'browser.permission.request': { method: 'POST', path: '/browser/permission/request' },
  'browser.permission.approve': { method: 'POST', path: '/browser/permission/approve' },
  'browser.permission.deny': { method: 'POST', path: '/browser/permission/deny' },
};

function bodyPermissionToken(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as { permissionToken?: unknown }).permissionToken;
  return typeof value === 'string' ? value : undefined;
}

async function readResponseBody(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number.isFinite(Number(contentLength)) && Number(contentLength) > maxBytes) {
    throw new BridgeError(502, 'BROWSER_API_RESPONSE_TOO_LARGE', 'The Browser API response exceeds the bridge limit.');
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new BridgeError(502, 'BROWSER_API_RESPONSE_TOO_LARGE', 'The Browser API response exceeds the bridge limit.');
    return buffer.toString('utf8');
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = Buffer.from(next.value);
    total += chunk.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BridgeError(502, 'BROWSER_API_RESPONSE_TOO_LARGE', 'The Browser API response exceeds the bridge limit.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isApprovalEndpoint(endpoint: BridgeEndpoint): boolean {
  return endpoint === 'browser.permission.approve' || endpoint === 'browser.permission.deny';
}

export class BrowserApiForwarder {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: BridgeConfig, fetchImpl: FetchLike = globalThis.fetch) {
    this.baseUrl = browserApiBaseUrl(config);
    this.fetchImpl = fetchImpl;
  }

  async health(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.forwardTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/healthz`, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      await readResponseBody(response, this.config.maxResponseBytes);
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async forward(endpoint: BridgeEndpoint, payload: unknown, context: ForwardContext): Promise<ForwardResult> {
    const route = ROUTES[endpoint];
    const headers = new Headers({
      accept: 'application/json',
      'cache-control': 'no-store',
    });
    if (this.config.browserApiSecret) headers.set('x-browser-api-secret', this.config.browserApiSecret);
    if (context.sessionId) headers.set('x-browser-session', context.sessionId);

    if (isApprovalEndpoint(endpoint)) {
      if (!context.approvalSecret) {
        throw new BridgeError(403, 'APPROVAL_FORBIDDEN', 'An explicit approval secret is required for approval forwarding.');
      }
      headers.set('x-browser-approval-secret', context.approvalSecret);
    }

    if (context.permissionToken) {
      const bodyToken = bodyPermissionToken(payload);
      if (bodyToken && bodyToken !== context.permissionToken) {
        throw new BridgeError(400, 'TOKEN_CONFLICT', 'The permission token header and payload token do not match.');
      }
      headers.set('x-permission-token', context.permissionToken);
    }

    let url = `${this.baseUrl}${route.path}`;
    let body: string | undefined;
    if (endpoint === 'browser.dom') {
      const domPayload = payload as { tabId: number; sessionId?: string };
      const query = new URLSearchParams({ tabId: String(domPayload.tabId) });
      if (domPayload.sessionId) query.set('sessionId', domPayload.sessionId);
      url += `?${query.toString()}`;
    } else {
      body = JSON.stringify(payload);
      headers.set('content-type', 'application/json');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.forwardTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: route.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'error',
        signal: controller.signal,
      });
      const responseBody = await readResponseBody(response, this.config.maxResponseBytes);
      const contentType = response.headers.get('content-type') || undefined;
      return {
        status: response.status,
        body: responseBody,
        ...(contentType ? { contentType } : {}),
      };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new BridgeError(504, 'BROWSER_API_TIMEOUT', 'The Browser API did not respond before the forwarding timeout.');
      }
      throw new BridgeError(502, 'BROWSER_API_UNREACHABLE', 'The Browser API could not be reached.');
    } finally {
      clearTimeout(timer);
    }
  }
}
