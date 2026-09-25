import path from 'node:path';

export interface BrowserApiConfig {
  host: string;
  port: number;
  headless: boolean;
  chromiumSandbox: boolean;
  apiSecret: string;
  approvalSecret: string;
  sessionTtlMs: number;
  permissionRequestTtlMs: number;
  permissionTtlMs: number;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
  maxWorkflowSteps: number;
  maxDomElements: number;
  maxQueryMatches: number;
  maxScreenshotBytes: number;
  maxEvalCodeBytes: number;
  evalTimeoutMs: number;
  allowPrivateNetworks: boolean;
  allowedHosts: string[];
  browserExecutablePath?: string;
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrowserApiConfig {
  const allowedHosts = (env.BROWSER_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const executable = env.BROWSER_EXECUTABLE_PATH || undefined;
  const config: BrowserApiConfig = {
    host: env.BROWSER_API_HOST || '127.0.0.1',
    port: integerEnv('BROWSER_API_PORT', 8787, 1, 65_535),
    headless: booleanEnv('BROWSER_HEADLESS', true),
    chromiumSandbox: booleanEnv('BROWSER_CHROMIUM_SANDBOX', true),
    apiSecret: env.BROWSER_API_SECRET || '',
    approvalSecret: env.BROWSER_APPROVAL_SECRET || '',
    sessionTtlMs: integerEnv('BROWSER_SESSION_TTL_MS', 60 * 60 * 1_000, 60_000, 24 * 60 * 60 * 1_000),
    permissionRequestTtlMs: integerEnv('BROWSER_PERMISSION_REQUEST_TTL_MS', 5 * 60 * 1_000, 30_000, 60 * 60 * 1_000),
    permissionTtlMs: integerEnv('BROWSER_PERMISSION_TTL_MS', 60_000, 5_000, 10 * 60 * 1_000),
    navigationTimeoutMs: integerEnv('BROWSER_NAVIGATION_TIMEOUT_MS', 30_000, 1_000, 120_000),
    actionTimeoutMs: integerEnv('BROWSER_ACTION_TIMEOUT_MS', 15_000, 1_000, 120_000),
    maxWorkflowSteps: integerEnv('BROWSER_MAX_WORKFLOW_STEPS', 50, 1, 100),
    maxDomElements: integerEnv('BROWSER_MAX_DOM_ELEMENTS', 500, 10, 5_000),
    maxQueryMatches: integerEnv('BROWSER_MAX_QUERY_MATCHES', 200, 1, 1_000),
    maxScreenshotBytes: integerEnv('BROWSER_MAX_SCREENSHOT_BYTES', 8 * 1024 * 1024, 100_000, 50 * 1024 * 1024),
    maxEvalCodeBytes: integerEnv('BROWSER_MAX_EVAL_CODE_BYTES', 50_000, 100, 500_000),
    evalTimeoutMs: integerEnv('BROWSER_EVAL_TIMEOUT_MS', 250, 10, 5_000),
    allowPrivateNetworks: booleanEnv('BROWSER_ALLOW_PRIVATE_NETWORKS', false),
    allowedHosts,
    ...(executable ? { browserExecutablePath: path.resolve(executable) } : {}),
  };
  return config;
}
