import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeService } from '../../src/service.js';
import { BrowserApiForwarder } from '../../src/forwarder.js';
import { BRIDGE_ENDPOINTS } from '../../src/contracts.js';
import { RecordingFetch, testConfig } from '../support.js';

function service(): BridgeService {
  const config = testConfig();
  return new BridgeService(config, new BrowserApiForwarder(config, new RecordingFetch().fetch));
}

test('accepts every supported endpoint with a matching payload', () => {
  const bridge = service();
  const payloads: Record<(typeof BRIDGE_ENDPOINTS)[number], unknown> = {
    'browser.session.start': {},
    'browser.session.end': {},
    'browser.dom': { tabId: 1 },
    'browser.query': { selector: '#title', tabId: 1 },
    'browser.action': { action: 'screenshot', selector: null, text: null, url: null, tabId: 1 },
    'browser.eval': { code: '1 + 1', tabId: 1, permissionToken: 'x'.repeat(24) },
    'browser.workflow': { steps: [{ action: 'scroll', selector: null, text: null, url: null, tabId: 1 }] },
    'browser.permission.request': { action: 'click', tabId: 1, selector: '#button' },
    'browser.permission.approve': { requestId: '11111111-1111-4111-8111-111111111111' },
    'browser.permission.deny': { requestId: '11111111-1111-4111-8111-111111111111' },
  };
  for (const endpoint of BRIDGE_ENDPOINTS) {
    const result = bridge.validate({ endpoint, payload: payloads[endpoint] });
    assert.equal(result.endpoint, endpoint);
  }
});

test('rejects unknown endpoints, extra envelope fields, and unknown payload fields', () => {
  const bridge = service();
  assert.throws(() => bridge.validate({ endpoint: 'browser.open', payload: {} }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INVALID_ENDPOINT');
  assert.throws(() => bridge.validate({ endpoint: 'browser.query', payload: { selector: 'h1', tabId: 1 }, extra: true }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INVALID_BRIDGE_REQUEST');
  assert.throws(() => bridge.validate({ endpoint: 'browser.query', payload: { selector: 'h1', tabId: 1, url: 'http://evil.test' } }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INVALID_PAYLOAD');
});

test('validates action-specific fields and workflow bounds', () => {
  const bridge = service();
  assert.throws(() => bridge.validate({ endpoint: 'browser.action', payload: { action: 'click', tabId: 1 } }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INVALID_PAYLOAD');
  assert.throws(() => bridge.validate({ endpoint: 'browser.action', payload: { action: 'navigate', tabId: 1 } }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INVALID_PAYLOAD');
  assert.throws(() => bridge.validate({ endpoint: 'browser.workflow', payload: { steps: [] } }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INVALID_PAYLOAD');
  assert.throws(() => bridge.validate({ endpoint: 'browser.permission.approve', payload: { requestId: 'not-a-uuid' } }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INVALID_PAYLOAD');
});
