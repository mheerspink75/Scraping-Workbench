import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { BrowserService } from './browser-service.js';
import { loadConfig, type BrowserApiConfig } from './config.js';
import { PermissionManager } from './permissions.js';
import { PlaywrightBackend } from './playwright-backend.js';
import { createApp } from './server.js';
import { SessionManager } from './session-manager.js';

export interface BrowserApiRuntime {
  app: ReturnType<typeof createApp>;
  server: Server | undefined;
  backend: PlaywrightBackend;
  sessions: SessionManager;
  permissions: PermissionManager;
  service: BrowserService;
  close(): Promise<void>;
}

export function createRuntime(config: BrowserApiConfig = loadConfig()): BrowserApiRuntime {
  const backend = new PlaywrightBackend(config);
  const permissions = new PermissionManager({
    requestTtlMs: config.permissionRequestTtlMs,
    tokenTtlMs: config.permissionTtlMs,
  });
  const sessions = new SessionManager(backend, permissions, { ttlMs: config.sessionTtlMs });
  const service = new BrowserService(backend, sessions, permissions, {
    maxWorkflowSteps: config.maxWorkflowSteps,
  });
  const app = createApp(service, config);
  let server: Server | undefined;
  return {
    app,
    backend,
    sessions,
    permissions,
    service,
    get server() {
      return server;
    },
    set server(value: Server | undefined) {
      server = value;
    },
    close: async () => {
      if (server) {
        server.closeIdleConnections();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server?.close(() => resolve()));
        server = undefined;
      }
      await sessions.close();
      await backend.close();
    },
  };
}

export async function startServer(config: BrowserApiConfig = loadConfig()): Promise<BrowserApiRuntime> {
  const runtime = createRuntime(config);
  await runtime.backend.launch();
  runtime.server = createServer(runtime.app);
  await new Promise<void>((resolve, reject) => {
    runtime.server?.once('error', reject);
    runtime.server?.listen(config.port, config.host, () => resolve());
  });
  const address = runtime.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  process.stdout.write(`Browser API listening on http://${config.host}:${port}\n`);
  return runtime;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().then((runtime) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void runtime.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
