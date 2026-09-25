export interface BridgeConfig {
  host: '127.0.0.1';
  port: number;
  browserApiPort: number;
  browserApiSecret: string;
  browserApprovalSecret: string;
  bridgeApiSecret: string;
  forwardTimeoutMs: number;
  maxBodyBytes: number;
  maxResponseBytes: number;
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return {
    host: '127.0.0.1',
    port: integerEnv('BRIDGE_PORT', 8790, 1, 65_535),
    browserApiPort: integerEnv('BROWSER_API_PORT', 8787, 1, 65_535),
    browserApiSecret: env.BROWSER_API_SECRET || '',
    browserApprovalSecret: env.BROWSER_APPROVAL_SECRET || '',
    bridgeApiSecret: env.BRIDGE_API_SECRET || '',
    forwardTimeoutMs: integerEnv('BRIDGE_FORWARD_TIMEOUT_MS', 35_000, 1_000, 120_000),
    maxBodyBytes: integerEnv('BRIDGE_MAX_BODY_BYTES', 256 * 1024, 1_024, 2 * 1024 * 1024),
    maxResponseBytes: integerEnv('BRIDGE_MAX_RESPONSE_BYTES', 2 * 1024 * 1024, 1_024, 20 * 1024 * 1024),
  };
}

export function browserApiBaseUrl(config: Pick<BridgeConfig, 'browserApiPort'>): string {
  return `http://127.0.0.1:${config.browserApiPort}`;
}
