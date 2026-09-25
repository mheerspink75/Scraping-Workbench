import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeError } from '../../src/errors.js';
import { postJson, startTestRuntime } from '../support.js';

const sessionId = '11111111-1111-4111-8111-111111111111';

test('health reports Browser API reachability without forwarding a user request', async () => {
  const runtime = await startTestRuntime();
  try {
    runtime.fetchMock.response = async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    const response = await fetch(`${runtime.baseUrl}/copilot/bridge/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', browserApiReachable: true });
    assert.equal(runtime.fetchMock.calls.length, 1);
    assert.equal(runtime.fetchMock.calls[0]?.url, 'http://127.0.0.1:9999/healthz');
  } finally {
    await runtime.close();
  }
});

test('health reports false when the fixed Browser API is unreachable', async () => {
  const runtime = await startTestRuntime();
  try {
    runtime.fetchMock.response = async () => { throw new Error('offline'); };
    const response = await fetch(`${runtime.baseUrl}/copilot/bridge/health`);
    assert.deepEqual(await response.json(), { status: 'ok', browserApiReachable: false });
  } finally {
    await runtime.close();
  }
});

test('bridge API secret protects the forwarding endpoint when configured', async () => {
  const runtime = await startTestRuntime({ bridgeApiSecret: 'bridge-secret' });
  try {
    const denied = await postJson(runtime.baseUrl, '/copilot/bridge', {
      endpoint: 'browser.session.start', payload: {},
    });
    assert.equal(denied.response.status, 401);
    assert.equal(runtime.fetchMock.calls.length, 0);

    const allowed = await postJson(runtime.baseUrl, '/copilot/bridge', {
      endpoint: 'browser.session.start', payload: {},
    }, { 'x-bridge-api-secret': 'bridge-secret' });
    assert.equal(allowed.response.status, 200);
    assert.equal(runtime.fetchMock.calls.length, 1);
  } finally {
    await runtime.close();
  }
});

test('normalizes invalid bridge requests and never calls fetch', async () => {
  const runtime = await startTestRuntime();
  try {
    const unknown = await postJson<{ error: { code: string } }>(runtime.baseUrl, '/copilot/bridge', {
      endpoint: 'browser.unknown', payload: {},
    });
    assert.equal(unknown.response.status, 400);
    assert.deepEqual(unknown.body, { error: { code: 'INVALID_ENDPOINT', message: 'Unsupported endpoint' } });

    const invalidPayload = await postJson<{ error: { code: string } }>(runtime.baseUrl, '/copilot/bridge', {
      endpoint: 'browser.query', payload: { selector: 'h1' },
    }, { 'x-browser-session': sessionId });
    assert.equal(invalidPayload.response.status, 400);
    assert.equal(invalidPayload.body.error.code, 'INVALID_PAYLOAD');

    const malformed = await fetch(`${runtime.baseUrl}/copilot/bridge`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
    assert.equal(runtime.fetchMock.calls.length, 0);
  } finally {
    await runtime.close();
  }
});

test('normalizes forwarding failures and caps upstream response bodies', async () => {
  const runtime = await startTestRuntime({ maxResponseBytes: 5 });
  try {
    runtime.fetchMock.response = async () => { throw new Error('connection refused'); };
    const unavailable = await postJson<{ error: { code: string } }>(runtime.baseUrl, '/copilot/bridge', {
      endpoint: 'browser.query', payload: { selector: 'h1', tabId: 1 },
    }, { 'x-browser-session': sessionId });
    assert.equal(unavailable.response.status, 502);
    assert.equal(unavailable.body.error.code, 'BROWSER_API_UNREACHABLE');

    runtime.fetchMock.response = async () => new Response('0123456789', { status: 200, headers: { 'content-type': 'text/plain' } });
    const tooLarge = await postJson<{ error: { code: string } }>(runtime.baseUrl, '/copilot/bridge', {
      endpoint: 'browser.query', payload: { selector: 'h1', tabId: 1 },
    }, { 'x-browser-session': sessionId });
    assert.equal(tooLarge.response.status, 502);
    assert.equal(tooLarge.body.error.code, 'BROWSER_API_RESPONSE_TOO_LARGE');
  } finally {
    await runtime.close();
  }
});

test('does not forward client cookies, authorization, forwarding, or API-secret headers', async () => {
  const runtime = await startTestRuntime();
  try {
    await postJson(runtime.baseUrl, '/copilot/bridge', {
      endpoint: 'browser.session.start', payload: {},
    }, {
      cookie: 'session=secret',
      authorization: 'Bearer secret',
      'x-browser-api-secret': 'client-supplied',
      'x-forwarded-host': 'evil.test',
      forwarded: 'for=evil',
    });
    const upstreamHeaders = new Headers(runtime.fetchMock.calls[0]?.init.headers);
    assert.equal(upstreamHeaders.get('cookie'), null);
    assert.equal(upstreamHeaders.get('authorization'), null);
    assert.equal(upstreamHeaders.get('x-browser-api-secret'), 'api-secret');
    assert.equal(upstreamHeaders.get('x-forwarded-host'), null);
    assert.equal(upstreamHeaders.get('forwarded'), null);
  } finally {
    await runtime.close();
  }
});

test('rejects unsupported HTTP methods and does not expose a generic proxy', async () => {
  const runtime = await startTestRuntime();
  try {
    const response = await fetch(`${runtime.baseUrl}/copilot/bridge`, { method: 'GET' });
    assert.equal(response.status, 404);
    assert.equal(runtime.fetchMock.calls.length, 0);
  } finally {
    await runtime.close();
  }
});

test('BridgeError remains structured for direct service callers', () => {
  const error = new BridgeError(418, 'TEST', 'test');
  assert.equal(error.status, 418);
  assert.equal(error.code, 'TEST');
});
