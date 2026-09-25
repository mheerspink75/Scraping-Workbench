import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeError } from '../../src/errors.js';
import { startTestRuntime } from '../support.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const token = 'browser-permission-' + 'x'.repeat(30);

test('burns a permission token after its first forward attempt', async () => {
  const runtime = await startTestRuntime();
  try {
    const request = {
      endpoint: 'browser.action' as const,
      payload: { action: 'click', selector: '#go', text: null, url: null, tabId: 1 },
    };
    const first = await runtime.service.forward(request, { sessionId, permissionToken: token });
    assert.equal(first.status, 200);
    await assert.rejects(
      () => runtime.service.forward(request, { sessionId, permissionToken: token }),
      (error: unknown) => error instanceof BridgeError && error.code === 'PERMISSION_REPLAYED',
    );
    assert.equal(runtime.fetchMock.calls.length, 1);
  } finally {
    await runtime.close();
  }
});
