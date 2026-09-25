import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import type { SessionState } from '../../src/contracts.js';
import { startServer } from '../../src/index.js';
import { jsonRequest } from '../support/runtime.js';
import { testConfig } from '../support/runtime.js';

const browserExecutable = chromium.executablePath();
const browserAvailable = fs.existsSync(browserExecutable);
const browserSkipReason = `Chromium executable is not installed at ${browserExecutable}; run "npx playwright install chromium".`;

const fixtureHtml = `<!doctype html>
<html><head><title>Browser fixture</title></head>
<body>
  <h1 id="title">Hello from fixture</h1>
  <input id="input" aria-label="Name" oninput="document.getElementById('output').textContent=this.value">
  <button id="button" onclick="document.getElementById('output').textContent='Clicked'">Click me</button>
  <div id="output">Idle</div>
  <script>document.cookie='session=should-not-be-readable'; localStorage.setItem('token','should-not-be-readable');</script>
</body></html>`;

async function startFixture(): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixtureHtml);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function approvedToken(
  baseUrl: string,
  sessionId: string,
  tabId: number,
  action: 'navigate' | 'click' | 'type' | 'evaluate',
  details: Record<string, unknown>,
): Promise<string> {
  const requested = await jsonRequest<{ requestId: string }>(baseUrl, '/browser/permission/request', {
    method: 'POST',
    headers: { 'x-browser-session': sessionId },
    body: JSON.stringify({ action, tabId, ...details, reason: 'integration test approval' }),
  });
  assert.equal(requested.response.status, 202);
  const approved = await jsonRequest<{ token: string }>(baseUrl, '/browser/permission/approve', {
    method: 'POST',
    headers: { 'x-browser-approval-secret': 'test-approval-secret' },
    body: JSON.stringify({ requestId: requested.body.requestId }),
  });
  assert.equal(approved.response.status, 200);
  return approved.body.token;
}

test('Playwright backend supports real navigation, inspection, actions, sandboxed eval, and workflows', { skip: browserAvailable ? false : browserSkipReason }, async () => {
  const fixture = await startFixture();
  const runtime = await startServer(testConfig({
    port: 0,
    allowPrivateNetworks: true,
    chromiumSandbox: false,
    approvalSecret: 'test-approval-secret',
  }));
  try {
    const address = runtime.server?.address();
    assert.ok(address && typeof address !== 'string');
    const apiBase = `http://127.0.0.1:${address.port}`;
    const started = await jsonRequest<SessionState>(apiBase, '/browser/session/start', {
      method: 'POST',
      body: '{}',
    });
    assert.equal(started.response.status, 201);
    const session = started.body;
    const headers = { 'x-browser-session': session.sessionId };
    const action = (body: Record<string, unknown>, token?: string) => jsonRequest<{ ok: boolean; result: Record<string, unknown> }>(apiBase, '/browser/action', {
      method: 'POST',
      headers: { ...headers, ...(token ? { 'x-permission-token': token } : {}) },
      body: JSON.stringify(body),
    });

    const navigateToken = await approvedToken(apiBase, session.sessionId, session.tabId, 'navigate', { url: fixture.url });
    const navigated = await action({ action: 'navigate', selector: null, text: null, url: fixture.url, tabId: session.tabId }, navigateToken);
    assert.equal(navigated.response.status, 200);

    const dom = await jsonRequest<{ title: string; elements: Array<{ id?: string; text: string }> }>(apiBase, `/browser/dom?tabId=${session.tabId}`, { headers });
    assert.equal(dom.response.status, 200);
    assert.equal(dom.body.title, 'Browser fixture');
    assert.ok(dom.body.elements.some((element) => element.id === 'title' && element.text === 'Hello from fixture'));

    const query = await jsonRequest<{ count: number }>(apiBase, '/browser/query', {
      method: 'POST', headers, body: JSON.stringify({ selector: '#title', tabId: session.tabId }),
    });
    assert.equal(query.response.status, 200);
    assert.equal(query.body.count, 1);

    const evalToken = await approvedToken(apiBase, session.sessionId, session.tabId, 'evaluate', { text: 'document.querySelector("#title").text' });
    const evaluated = await jsonRequest<{ value: string }>(apiBase, '/browser/eval', {
      method: 'POST', headers, body: JSON.stringify({ code: 'document.querySelector("#title").text', tabId: session.tabId, permissionToken: evalToken }),
    });
    assert.equal(evaluated.response.status, 200);
    assert.equal(evaluated.body.value, 'Hello from fixture');

    for (const code of ['localStorage.getItem("token")', 'document.cookie', 'fetch("http://127.0.0.1/")']) {
      const blocked = await jsonRequest(apiBase, '/browser/eval', {
        method: 'POST', headers, body: JSON.stringify({ code, tabId: session.tabId, permissionToken: await approvedToken(apiBase, session.sessionId, session.tabId, 'evaluate', { text: code }) }),
      });
      assert.equal(blocked.response.status, 403, code);
    }

    const typeToken = await approvedToken(apiBase, session.sessionId, session.tabId, 'type', { selector: '#input', text: 'typed value' });
    const typed = await action({ action: 'type', selector: '#input', text: 'typed value', url: null, tabId: session.tabId }, typeToken);
    assert.equal(typed.response.status, 200);
    const extracted = await action({ action: 'extract', selector: '#output', text: null, url: null, tabId: session.tabId });
    assert.deepEqual(extracted.body.result.texts, ['typed value']);

    const clickToken = await approvedToken(apiBase, session.sessionId, session.tabId, 'click', { selector: '#button' });
    const clicked = await action({ action: 'click', selector: '#button', text: null, url: null, tabId: session.tabId }, clickToken);
    assert.equal(clicked.response.status, 200);
    const clickedOutput = await action({ action: 'extract', selector: '#output', text: null, url: null, tabId: session.tabId });
    assert.deepEqual(clickedOutput.body.result.texts, ['Clicked']);

    const screenshot = await action({ action: 'screenshot', selector: null, text: null, url: null, tabId: session.tabId });
    assert.equal(screenshot.response.status, 200);
    assert.equal(screenshot.body.result.mimeType, 'image/png');

    const workflowTypeToken = await approvedToken(apiBase, session.sessionId, session.tabId, 'type', { selector: '#input', text: 'workflow' });
    const workflowClickToken = await approvedToken(apiBase, session.sessionId, session.tabId, 'click', { selector: '#button' });
    const workflow = await jsonRequest<{ status: string; steps: Array<{ ok: boolean }> }>(apiBase, '/browser/workflow', {
      method: 'POST', headers, body: JSON.stringify({ steps: [
        { action: 'type', selector: '#input', text: 'workflow', url: null, tabId: session.tabId, permissionToken: workflowTypeToken },
        { action: 'click', selector: '#button', text: null, url: null, tabId: session.tabId, permissionToken: workflowClickToken },
      ] }),
    });
    assert.equal(workflow.response.status, 200);
    assert.equal(workflow.body.status, 'completed');
    assert.deepEqual(workflow.body.steps.map((step) => step.ok), [true, true]);
  } finally {
    await runtime.close();
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});
