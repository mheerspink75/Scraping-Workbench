import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BridgeConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import type { FetchLike } from '../src/forwarder.js';
import { BrowserApiForwarder } from '../src/forwarder.js';
import { BridgeService } from '../src/service.js';
import { createApp } from '../src/server.js';

export interface RecordedFetch {
  url: string;
  init: RequestInit;
}

export class RecordingFetch {
  readonly calls: RecordedFetch[] = [];
  response: () => Promise<Response> = async () => new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  readonly fetch: FetchLike = async (input, init = {}) => {
    this.calls.push({ url: String(input), init });
    return this.response();
  };
}

export function testConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  const base = loadConfig({} as NodeJS.ProcessEnv);
  return {
    ...base,
    port: 0,
    browserApiPort: 9999,
    browserApiSecret: 'api-secret',
    browserApprovalSecret: 'approval-secret',
    ...overrides,
  };
}

export interface TestRuntime {
  baseUrl: string;
  server: Server;
  service: BridgeService;
  fetchMock: RecordingFetch;
  close(): Promise<void>;
}

export async function startTestRuntime(overrides: Partial<BridgeConfig> = {}): Promise<TestRuntime> {
  const config = testConfig(overrides);
  const fetchMock = new RecordingFetch();
  const forwarder = new BrowserApiForwarder(config, fetchMock.fetch);
  const service = new BridgeService(config, forwarder);
  const app = createApp(service, config);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    service,
    fetchMock,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export async function postJson<T = unknown>(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ response: Response; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* preserve raw text */ }
  return { response, body: parsed as T };
}
