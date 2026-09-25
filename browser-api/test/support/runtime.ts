import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrowserService } from '../../src/browser-service.js';
import type { BrowserBackend } from '../../src/browser-backend.js';
import { loadConfig, type BrowserApiConfig } from '../../src/config.js';
import { PermissionManager } from '../../src/permissions.js';
import { createApp } from '../../src/server.js';
import { SessionManager } from '../../src/session-manager.js';
import { FakeBrowserBackend } from './fake-backend.js';

export interface TestRuntime {
  app: ReturnType<typeof createApp>;
  server: Server;
  baseUrl: string;
  backend: BrowserBackend;
  service: BrowserService;
  sessions: SessionManager;
  permissions: PermissionManager;
  close(): Promise<void>;
}

export function testConfig(overrides: Partial<BrowserApiConfig> = {}): BrowserApiConfig {
  const base = loadConfig({} as NodeJS.ProcessEnv);
  return {
    ...base,
    host: '127.0.0.1',
    port: 0,
    approvalSecret: 'test-approval-secret',
    allowPrivateNetworks: true,
    ...overrides,
  };
}

export function makeTestServices(backend: BrowserBackend, config: BrowserApiConfig) {
  const permissions = new PermissionManager({ requestTtlMs: 60_000, tokenTtlMs: 60_000 });
  const sessions = new SessionManager(backend, permissions, { ttlMs: 60 * 60 * 1_000 });
  const service = new BrowserService(backend, sessions, permissions, { maxWorkflowSteps: config.maxWorkflowSteps });
  return { permissions, sessions, service };
}

export async function startTestServer(backend: BrowserBackend, config: BrowserApiConfig): Promise<TestRuntime> {
  const { permissions, sessions, service } = makeTestServices(backend, config);
  const app = createApp(service, config);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    app,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    backend,
    service,
    sessions,
    permissions,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await sessions.close();
      await backend.close();
    },
  };
}

export async function jsonRequest<T = unknown>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { response, body: body as T };
}

export async function startFakeRuntime(overrides: Partial<BrowserApiConfig> = {}): Promise<TestRuntime> {
  return startTestServer(new FakeBrowserBackend(), testConfig(overrides));
}
