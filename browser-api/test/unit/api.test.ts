import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionState } from '../../src/contracts.js';
import { jsonRequest, startFakeRuntime, type TestRuntime } from '../support/runtime.js';

async function withRuntime(run: (runtime: TestRuntime, session: SessionState, headers: Record<string, string>) => Promise<void>): Promise<void> {
  const runtime = await startFakeRuntime();
  try {
    const started = await jsonRequest<SessionState>(runtime.baseUrl, '/browser/session/start', {
      method: 'POST',
      body: JSON.stringify({ metadata: { purpose: 'unit-test' } }),
    });
    assert.equal(started.response.status, 201);
    const session = started.body;
    const headers = { 'x-browser-session': session.sessionId };
    await run(runtime, session, headers);
  } finally {
    await runtime.close();
  }
}

async function approve(runtime: TestRuntime, sessionId: string, action: 'click' | 'type' | 'navigate' | 'evaluate', tabId: number, details: Record<string, unknown> = {}, reason = 'unit test approval') {
  const requested = await jsonRequest<{ requestId: string }>(runtime.baseUrl, '/browser/permission/request', {
    method: 'POST',
    headers: { 'x-browser-session': sessionId },
    body: JSON.stringify({ action, tabId, ...details, reason }),
  });
  assert.equal(requested.response.status, 202);
  const approved = await jsonRequest<{ token: string }>(runtime.baseUrl, '/browser/permission/approve', {
    method: 'POST',
    headers: { 'x-browser-approval-secret': 'test-approval-secret' },
    body: JSON.stringify({ requestId: requested.body.requestId }),
  });
  assert.equal(approved.response.status, 200);
  return approved.body.token;
}

test('optional API secret protects non-health endpoints', async () => {
  const runtime = await startFakeRuntime({ apiSecret: 'api-secret' });
  try {
    const health = await jsonRequest(runtime.baseUrl, '/healthz');
    assert.equal(health.response.status, 200);
    const denied = await jsonRequest(runtime.baseUrl, '/browser/session/start', { method: 'POST', body: '{}' });
    assert.equal(denied.response.status, 401);
    const allowed = await jsonRequest(runtime.baseUrl, '/browser/session/start', {
      method: 'POST', headers: { 'x-browser-api-secret': 'api-secret' }, body: '{}',
    });
    assert.equal(allowed.response.status, 201);
  } finally {
    await runtime.close();
  }
});

test('health, session lifecycle, and protected session headers', async () => {
  await withRuntime(async (runtime, session, headers) => {
    const health = await jsonRequest<{ ok: boolean }>(runtime.baseUrl, '/healthz');
    assert.equal(health.response.status, 200);
    assert.equal(health.body.ok, true);

    const missingHeader = await jsonRequest(runtime.baseUrl, '/browser/dom?tabId=1');
    assert.equal(missingHeader.response.status, 401);

    const state = await jsonRequest<{ session: SessionState }>(runtime.baseUrl, '/browser/session', { headers });
    assert.equal(state.response.status, 200);
    assert.equal(state.body.session.sessionId, session.sessionId);

    const wrongTab = await jsonRequest(runtime.baseUrl, '/browser/action', {
      method: 'POST', headers, body: JSON.stringify({ action: 'scroll', selector: null, text: null, url: null, tabId: session.tabId + 1 }),
    });
    assert.equal(wrongTab.response.status, 403);
    assert.equal((wrongTab.body as { error: { code: string } }).error.code, 'TAB_NOT_ACCESSIBLE');

    const ended = await jsonRequest(runtime.baseUrl, '/browser/session/end', { method: 'POST', headers, body: '{}' });
    assert.equal(ended.response.status, 200);
    const afterEnd = await jsonRequest(runtime.baseUrl, '/browser/dom?tabId=1', { headers });
    assert.equal(afterEnd.response.status, 404);
  });
});

test('action endpoint enforces permission tokens for every mutating action', async () => {
  await withRuntime(async (runtime, session, headers) => {
    const baseAction = { selector: '#target', text: null, url: null, tabId: session.tabId };
    for (const action of ['navigate', 'click', 'type', 'evaluate'] as const) {
      const denied = await jsonRequest(runtime.baseUrl, '/browser/action', {
        method: 'POST', headers, body: JSON.stringify({ ...baseAction, action, ...(action === 'navigate' ? { url: 'https://example.test/' } : {}), ...(action === 'type' ? { text: 'test' } : {}), ...(action === 'evaluate' ? { text: '1 + 1' } : {}) }),
      });
      assert.equal(denied.response.status, 403, action);
      assert.equal((denied.body as { error: { code: string } }).error.code, 'PERMISSION_REQUIRED');
    }

    const navigateToken = await approve(runtime, session.sessionId, 'navigate', session.tabId, { url: 'https://example.test/' });
    const navigated = await jsonRequest(runtime.baseUrl, '/browser/action', {
      method: 'POST', headers, body: JSON.stringify({ ...baseAction, action: 'navigate', url: 'https://example.test/', permissionToken: navigateToken }),
    });
    assert.equal(navigated.response.status, 200);

    const clickToken = await approve(runtime, session.sessionId, 'click', session.tabId, { selector: '#target' });
    const clicked = await jsonRequest(runtime.baseUrl, '/browser/action', {
      method: 'POST', headers, body: JSON.stringify({ ...baseAction, action: 'click', permissionToken: clickToken }),
    });
    assert.equal(clicked.response.status, 200);

    const scopeToken = await approve(runtime, session.sessionId, 'click', session.tabId, { selector: '#target' });
    const wrongScope = await jsonRequest(runtime.baseUrl, '/browser/action', {
      method: 'POST', headers, body: JSON.stringify({ ...baseAction, action: 'type', text: 'secret', permissionToken: scopeToken }),
    });
    assert.equal(wrongScope.response.status, 403);
    assert.equal((wrongScope.body as { error: { code: string } }).error.code, 'PERMISSION_SCOPE_MISMATCH');

    const typeToken = await approve(runtime, session.sessionId, 'type', session.tabId, { selector: '#safe', text: 'same text' });
    const crossSelector = await jsonRequest(runtime.baseUrl, '/browser/action', {
      method: 'POST', headers, body: JSON.stringify({ action: 'type', selector: '#admin', text: 'same text', url: null, tabId: session.tabId, permissionToken: typeToken }),
    });
    assert.equal(crossSelector.response.status, 403);
    assert.equal((crossSelector.body as { error: { code: string } }).error.code, 'PERMISSION_SCOPE_MISMATCH');
  });
});

test('read endpoints and non-mutating actions work without approval', async () => {
  await withRuntime(async (runtime, session, headers) => {
    const dom = await jsonRequest<{ title: string }>(runtime.baseUrl, `/browser/dom?tabId=${session.tabId}`, { headers });
    assert.equal(dom.response.status, 200);
    assert.equal(dom.body.title, 'Example');

    const query = await jsonRequest<{ count: number }>(runtime.baseUrl, '/browser/query', {
      method: 'POST', headers, body: JSON.stringify({ selector: 'h1', tabId: session.tabId }),
    });
    assert.equal(query.response.status, 200);
    assert.equal(query.body.count, 1);

    for (const action of ['scroll', 'extract', 'waitFor', 'screenshot'] as const) {
      const result = await jsonRequest(runtime.baseUrl, '/browser/action', {
        method: 'POST', headers, body: JSON.stringify({ action, selector: action === 'scroll' ? null : 'h1', text: action === 'waitFor' ? 'Example' : null, url: null, tabId: session.tabId }),
      });
      assert.equal(result.response.status, 200, action);
    }
  });
});

test('eval endpoint uses approval and a separate sandboxed evaluator', async () => {
  await withRuntime(async (runtime, session, headers) => {
    const denied = await jsonRequest(runtime.baseUrl, '/browser/eval', {
      method: 'POST', headers, body: JSON.stringify({ code: '1 + 1', tabId: session.tabId }),
    });
    assert.equal(denied.response.status, 403);
    const token = await approve(runtime, session.sessionId, 'evaluate', session.tabId, { text: '1 + 1' });
    const allowed = await jsonRequest<{ value: number }>(runtime.baseUrl, '/browser/eval', {
      method: 'POST', headers, body: JSON.stringify({ code: '1 + 1', tabId: session.tabId, permissionToken: token }),
    });
    assert.equal(allowed.response.status, 200);
    assert.equal(allowed.body.value, 42);
  });
});

test('workflows execute sequentially, require per-step approval, and persist state', async () => {
  await withRuntime(async (runtime, session, headers) => {
    const clickToken = await approve(runtime, session.sessionId, 'click', session.tabId, { selector: '#target' });
    const typeToken = await approve(runtime, session.sessionId, 'type', session.tabId, { selector: '#target', text: 'hello' });
    const steps = [
      { action: 'click', selector: '#target', text: null, url: null, tabId: session.tabId, permissionToken: clickToken },
      { action: 'type', selector: '#target', text: 'hello', url: null, tabId: session.tabId, permissionToken: typeToken },
    ];
    const workflow = await jsonRequest<{ workflowId: string; status: string; steps: Array<{ index: number }> }>(runtime.baseUrl, '/browser/workflow', {
      method: 'POST', headers, body: JSON.stringify({ steps }),
    });
    assert.equal(workflow.response.status, 200);
    assert.equal(workflow.body.status, 'completed');
    assert.deepEqual(workflow.body.steps.map((step) => step.index), [0, 1]);

    const state = await jsonRequest<{ status: string }>(runtime.baseUrl, `/browser/workflow/${workflow.body.workflowId}`, { headers });
    assert.equal(state.response.status, 200);
    assert.equal(state.body.status, 'completed');

    const denied = await jsonRequest<{ status: string; steps: Array<{ ok: boolean }> }>(runtime.baseUrl, '/browser/workflow', {
      method: 'POST', headers, body: JSON.stringify({ steps: [steps[0]] }),
    });
    assert.equal(denied.response.status, 200);
    assert.equal(denied.body.status, 'denied');
    assert.equal(denied.body.steps[0]?.ok, false);
  });
});

test('approval endpoints require the separate approval secret', async () => {
  await withRuntime(async (runtime, session, headers) => {
    const request = await jsonRequest<{ requestId: string }>(runtime.baseUrl, '/browser/permission/request', {
      method: 'POST', headers, body: JSON.stringify({ action: 'click', tabId: session.tabId, selector: '#target' }),
    });
    const pendingList = await jsonRequest<{ pending: unknown[] }>(runtime.baseUrl, '/browser/permissions', { headers });
    assert.equal(pendingList.response.status, 403);
    const listed = await jsonRequest<{ pending: Array<{ requestId: string }> }>(runtime.baseUrl, '/browser/permissions', {
      headers: { ...headers, 'x-browser-approval-secret': 'test-approval-secret' },
    });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.pending[0]?.requestId, request.body.requestId);
    const denied = await jsonRequest(runtime.baseUrl, '/browser/permission/approve', {
      method: 'POST', body: JSON.stringify({ requestId: request.body.requestId }),
    });
    assert.equal(denied.response.status, 403);
    const approved = await jsonRequest(runtime.baseUrl, '/browser/permission/approve', {
      method: 'POST', headers: { 'x-browser-approval-secret': 'test-approval-secret' }, body: JSON.stringify({ requestId: request.body.requestId }),
    });
    assert.equal(approved.response.status, 200);
  });
});
