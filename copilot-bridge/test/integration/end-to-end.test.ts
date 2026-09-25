import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { startServer } from '../../src/index.js';
import { postJson } from '../support.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const token = 'browser-permission-' + 'z'.repeat(30);

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

test('Copilot HTTP envelope traverses Bridge to a Browser API-shaped upstream', async () => {
  const upstream = http.createServer((request, response) => {
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true,"service":"browser-api"}');
      return;
    }
    if (request.url === '/browser/session/start' && request.method === 'POST') {
      assert.equal(request.headers['x-browser-api-secret'], 'api-secret');
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end('{"sessionId":"' + sessionId + '","tabId":1}');
      return;
    }
    if (request.url === '/browser/query' && request.method === 'POST') {
      assert.equal(request.headers['x-browser-session'], sessionId);
      assert.equal(request.headers['x-browser-api-secret'], 'api-secret');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"matches":[],"source":"browser-api"}');
      return;
    }
    if (request.url === '/browser/action' && request.method === 'POST') {
      assert.equal(request.headers['x-permission-token'], token);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true,"action":"click"}');
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":{"code":"NOT_FOUND","message":"missing fixture route"}}');
  });
  const upstreamPort = await listen(upstream);
  const bridge = await startServer({
    host: '127.0.0.1',
    port: 0,
    browserApiPort: upstreamPort,
    browserApiSecret: 'api-secret',
    browserApprovalSecret: 'approval-secret',
    bridgeApiSecret: 'bridge-secret',
    forwardTimeoutMs: 5_000,
    maxBodyBytes: 256 * 1024,
    maxResponseBytes: 2 * 1024 * 1024,
  });
  const bridgePort = (bridge.server?.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${bridgePort}`;
  const bridgeHeaders = { 'x-bridge-api-secret': 'bridge-secret' };

  try {
    const health = await fetch(`${baseUrl}/copilot/bridge/health`);
    assert.deepEqual(await health.json(), { status: 'ok', browserApiReachable: true });

    const started = await postJson<{ sessionId: string; tabId: number }>(baseUrl, '/copilot/bridge', {
      endpoint: 'browser.session.start', payload: {},
    }, bridgeHeaders);
    assert.equal(started.response.status, 201);
    assert.deepEqual(started.body, { sessionId, tabId: 1 });

    const queried = await postJson<{ source: string }>(baseUrl, '/copilot/bridge', {
      endpoint: 'browser.query', payload: { selector: '#result', tabId: 1 },
    }, { ...bridgeHeaders, 'x-browser-session': sessionId });
    assert.equal(queried.response.status, 200);
    assert.deepEqual(queried.body, { matches: [], source: 'browser-api' });

    const acted = await postJson<{ ok: boolean; action: string }>(baseUrl, '/copilot/bridge', {
      endpoint: 'browser.action', payload: { action: 'click', selector: '#result', text: null, url: null, tabId: 1 },
    }, { ...bridgeHeaders, 'x-browser-session': sessionId, 'x-permission-token': token });
    assert.equal(acted.response.status, 200);
    assert.deepEqual(acted.body, { ok: true, action: 'click' });

    const unknown = await postJson(baseUrl, '/copilot/bridge', {
      endpoint: 'browser.not-allowed', payload: {},
    }, bridgeHeaders);
    assert.equal(unknown.response.status, 400);
    assert.deepEqual(unknown.body, { error: { code: 'INVALID_ENDPOINT', message: 'Unsupported endpoint' } });
  } finally {
    await bridge.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});
