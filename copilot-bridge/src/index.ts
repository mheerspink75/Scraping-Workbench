import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig, type BridgeConfig } from './config.js';
import { BrowserApiForwarder } from './forwarder.js';
import { BridgeService } from './service.js';
import { createApp } from './server.js';

export interface BridgeRuntime {
  app: ReturnType<typeof createApp>;
  config: BridgeConfig;
  forwarder: BrowserApiForwarder;
  service: BridgeService;
  server: Server | undefined;
  close(): Promise<void>;
}

export function createRuntime(config: BridgeConfig = loadConfig()): BridgeRuntime {
  const forwarder = new BrowserApiForwarder(config);
  const service = new BridgeService(config, forwarder);
  const app = createApp(service, config);
  let server: Server | undefined;
  return {
    app,
    config,
    forwarder,
    service,
    get server() { return server; },
    set server(value: Server | undefined) { server = value; },
    close: async () => {
      if (server) {
        server.closeIdleConnections();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server?.close(() => resolve()));
        server = undefined;
      }
    },
  };
}

export async function startServer(config: BridgeConfig = loadConfig()): Promise<BridgeRuntime> {
  const runtime = createRuntime(config);
  runtime.server = createServer(runtime.app);
  await new Promise<void>((resolve, reject) => {
    runtime.server?.once('error', reject);
    runtime.server?.listen(config.port, config.host, () => resolve());
  });
  const address = runtime.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  process.stdout.write(`Copilot Bridge listening on http://${config.host}:${port}\n`);
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
