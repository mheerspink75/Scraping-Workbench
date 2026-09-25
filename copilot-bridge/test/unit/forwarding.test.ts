import assert from 'node:assert/strict';
import test from 'node:test';
import type { BridgeEndpoint } from '../../src/contracts.js';
import { BridgeError } from '../../src/errors.js';
import { postJson, startTestRuntime } from '../support.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const token = 'browser-permission-' + 'x'.repeat(30);
const workflowToken = 'browser-permission-' + 'y'.repeat(30);

function actionPayload(action: string, extra: Record<string, unknown> = {}) {
  return { action, selector: null, text: null, url: null, tabId: 1, ...extra };
}

test('maps every supported endpoint to the fixed Browser API origin', async () => {
  const runtime = await startTestRuntime();
  try {
    const cases: Array<{ endpoint: BridgeEndpoint; payload: unknown; headers: Record<string, string>; path: string; method: string }> = [
      { endpoint: 'browser.session.start', payload: {}, headers: {}, path: '/browser/session/start', method: 'POST' },
      { endpoint: 'browser.session.end', payload: {}, headers: { sessionId }, path: '/browser/session/end', method: 'POST' },
      { endpoint: 'browser.dom', payload: { tabId: 1 }, headers: { sessionId }, path: '/browser/dom?tabId=1', method: 'GET' },
      { endpoint: 'browser.query', payload: { selector: '#title', tabId: 1 }, headers: { sessionId }, path: '/browser/query', method: 'POST' },
      { endpoint: 'browser.action', payload: actionPayload('screenshot'), headers: { sessionId }, path: '/browser/action', method: 'POST' },
      { endpoint: 'browser.eval', payload: { code: '1 + 1', tabId: 1 }, headers: { sessionId, permissionToken: token }, path: '/browser/eval', method: 'POST' },
      { endpoint: 'browser.workflow', payload: { steps: [actionPayload('click', { selector: '#go', permissionToken: workflowToken })] }, headers: { sessionId }, path: '/browser/workflow', method: 'POST' },
      { endpoint: 'browser.permission.request', payload: { action: 'click', tabId: 1, selector: '#go' }, headers: { sessionId }, path: '/browser/permission/request', method: 'POST' },
      { endpoint: 'browser.permission.approve', payload: { requestId }, headers: { approvalSecret: 'approval-secret' }, path: '/browser/permission/approve', method: 'POST' },
      { endpoint: 'browser.permission.deny', payload: { requestId }, headers: { approvalSecret: 'approval-secret' }, path: '/browser/permission/deny', method: 'POST' },
    ];
    for (const item of cases) {
      const before = runtime.fetchMock.calls.length;
      await runtime.service.forward({ endpoint: item.endpoint, payload: item.payload }, item.headers);
      const call = runtime.fetchMock.calls[before];
      assert.ok(call, item.endpoint);
      assert.equal(call.url, `http://127.0.0.1:9999${item.path}`);
      assert.equal(call.init.method, item.method);
      const headers = new Headers(call.init.headers);
      assert.equal(headers.get('x-browser-api-secret'), 'api-secret');
      if (item.endpoint !== 'browser.permission.approve' && item.endpoint !== 'browser.permission.deny') {
        assert.equal(headers.get('x-browser-approval-secret'), null);
      }
    }
  } finally {
    await runtime.close();
  }
});

test('never derives an upstream host from payload or incoming API-secret headers', async () => {
  const runtime = await startTestRuntime();
  try {
    await runtime.service.forward(
      { endpoint: 'browser.action', payload: actionPayload('navigate', { url: 'https://example.test/path', permissionToken: token }) },
      { sessionId },
    );
    const call = runtime.fetchMock.calls[0];
    assert.ok(call);
    assert.equal(new URL(call.url).hostname, '127.0.0.1');
    assert.equal(new URL(call.url).port, '9999');
    assert.equal(call.url.includes('example.test'), false);
  } finally {
    await runtime.close();
  }
});

test('rejects missing session/token/approval headers before fetching', async () => {
  const runtime = await startTestRuntime();
  try {
    await assert.rejects(() => runtime.service.forward({ endpoint: 'browser.query', payload: { selector: 'h1', tabId: 1 } }, {}), (error: unknown) => error instanceof BridgeError && error.code === 'SESSION_HEADER_REQUIRED');
    await assert.rejects(() => runtime.service.forward({ endpoint: 'browser.action', payload: actionPayload('click', { selector: '#go' }) }, { sessionId }), (error: unknown) => error instanceof BridgeError && error.code === 'PERMISSION_REQUIRED');
    await assert.rejects(() => runtime.service.forward({ endpoint: 'browser.permission.approve', payload: { requestId } }, {}), (error: unknown) => error instanceof BridgeError && error.code === 'APPROVAL_FORBIDDEN');
    assert.equal(runtime.fetchMock.calls.length, 0);
  } finally {
    await runtime.close();
  }
});

test('rejects token conflicts, read-only tokens, workflow-wide tokens, and approval TTL changes', async () => {
  const runtime = await startTestRuntime();
  try {
    await assert.rejects(() => runtime.service.forward(
      { endpoint: 'browser.action', payload: actionPayload('click', { selector: '#go', permissionToken: token }) },
      { sessionId, permissionToken: token },
    ), (error: unknown) => error instanceof BridgeError && error.code === 'TOKEN_CONFLICT');
    await assert.rejects(() => runtime.service.forward(
      { endpoint: 'browser.action', payload: actionPayload('screenshot', { permissionToken: token }) },
      { sessionId },
    ), (error: unknown) => error instanceof BridgeError && error.code === 'UNEXPECTED_PERMISSION_TOKEN');
    await assert.rejects(() => runtime.service.forward(
      { endpoint: 'browser.workflow', payload: { steps: [actionPayload('click', { selector: '#go', permissionToken: token })] } },
      { sessionId, permissionToken: token },
    ), (error: unknown) => error instanceof BridgeError && error.code === 'WORKFLOW_TOKEN_REQUIRED');
    await assert.rejects(() => runtime.service.forward(
      { endpoint: 'browser.permission.approve', payload: { requestId, ttlMs: 300000 } },
      { approvalSecret: 'approval-secret' },
    ), (error: unknown) => error instanceof BridgeError && error.code === 'APPROVAL_TTL_NOT_ALLOWED');
    assert.equal(runtime.fetchMock.calls.length, 0);
  } finally {
    await runtime.close();
  }
});

test('rejects prototype-pollution keys and returns upstream errors verbatim', async () => {
  const runtime = await startTestRuntime();
  try {
    await assert.rejects(() => runtime.service.forward({
      endpoint: 'browser.session.start',
      payload: { metadata: JSON.parse('{"__proto__":{"polluted":true}}') },
    }, {}), (error: unknown) => error instanceof BridgeError && ['INVALID_PAYLOAD', 'UNSAFE_OBJECT_KEY'].includes(error.code));

    runtime.fetchMock.response = async () => new Response('{"error":{"code":"PERMISSION_REQUIRED","message":"no"}}', {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
    const result = await postJson<{ error: { code: string } }>(runtime.baseUrl, '/copilot/bridge', {
      endpoint: 'browser.query', payload: { selector: 'h1', tabId: 1 },
    }, { 'x-browser-session': sessionId });
    assert.equal(result.response.status, 403);
    assert.deepEqual(result.body, { error: { code: 'PERMISSION_REQUIRED', message: 'no' } });
  } finally {
    await runtime.close();
  }
});
