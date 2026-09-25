import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionManager } from '../../src/permissions.js';
import { AppError } from '../../src/errors.js';

const scope = { sessionId: '11111111-1111-4111-8111-111111111111', tabId: 7, action: 'click' as const, requestHash: 'hash-click' };

test('permission tokens are scoped, expiring, and one-time', () => {
  let now = 1_000;
  const manager = new PermissionManager({ requestTtlMs: 10_000, tokenTtlMs: 5_000, now: () => now });
  const pending = manager.request(scope, 'user clicked approval');
  const token = manager.approve(pending.requestId);
  assert.equal(token.scope.sessionId, scope.sessionId);
  assert.equal(token.scope.tabId, scope.tabId);
  assert.equal(token.scope.action, 'click');
  manager.consume(token.token, scope);
  assert.throws(() => manager.consume(token.token, scope), (error: unknown) => error instanceof AppError && error.code === 'PERMISSION_INVALID');

  const second = manager.approve(manager.request(scope).requestId);
  assert.throws(() => manager.consume(second.token, { ...scope, tabId: 8 }), (error: unknown) => error instanceof AppError && error.code === 'PERMISSION_SCOPE_MISMATCH');
  assert.throws(() => manager.consume(second.token, scope), (error: unknown) => error instanceof AppError && error.code === 'PERMISSION_INVALID');

  const third = manager.approve(manager.request(scope).requestId);
  assert.throws(() => manager.consume(third.token, { ...scope, requestHash: 'different-operation' }), (error: unknown) => error instanceof AppError && error.code === 'PERMISSION_SCOPE_MISMATCH');
  now += 5_001;
  assert.throws(() => manager.consume(third.token, scope), (error: unknown) => error instanceof AppError && ['PERMISSION_EXPIRED', 'PERMISSION_INVALID'].includes(error.code));
});

test('only mutating actions can be requested and session revocation clears tokens', () => {
  const manager = new PermissionManager({ requestTtlMs: 10_000, tokenTtlMs: 5_000 });
  assert.throws(() => manager.request({ ...scope, action: 'screenshot' }), (error: unknown) => error instanceof AppError && error.code === 'ACTION_NOT_MUTATING');
  const token = manager.approve(manager.request(scope).requestId);
  manager.revokeSession(scope.sessionId);
  assert.throws(() => manager.consume(token.token, scope), (error: unknown) => error instanceof AppError && error.code === 'PERMISSION_INVALID');
});
