import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../../src/errors.js';
import { UrlPolicy } from '../../src/url-policy.js';

test('URL policy blocks dangerous protocols, credentials, and private addresses', async () => {
  const policy = new UrlPolicy({ allowPrivateNetworks: false, allowedHosts: [] });
  await assert.rejects(() => policy.assertNavigable('file:///etc/passwd'), (error: unknown) => error instanceof AppError && error.code === 'URL_PROTOCOL_BLOCKED');
  await assert.rejects(() => policy.assertNavigable('javascript:alert(1)'), (error: unknown) => error instanceof AppError && error.code === 'URL_PROTOCOL_BLOCKED');
  await assert.rejects(() => policy.assertNavigable('data:text/html,<script>alert(1)</script>'), (error: unknown) => error instanceof AppError && error.code === 'URL_PROTOCOL_BLOCKED');
  await assert.rejects(() => policy.assertNavigable('blob:https://example.test/id'), (error: unknown) => error instanceof AppError && error.code === 'URL_PROTOCOL_BLOCKED');
  await assert.rejects(() => policy.assertNavigable('https://user:pass@example.test/'), (error: unknown) => error instanceof AppError && error.code === 'URL_CREDENTIALS_BLOCKED');
  await assert.rejects(() => policy.assertNavigable('http://10.0.0.5/'), (error: unknown) => error instanceof AppError && error.code === 'NETWORK_ADDRESS_BLOCKED');
  await assert.rejects(() => policy.assertNavigable('http://169.254.169.254/'), (error: unknown) => error instanceof AppError && error.code === 'NETWORK_ADDRESS_BLOCKED');
  await assert.rejects(() => policy.assertNavigable('http://127.0.0.1:3000/'), (error: unknown) => error instanceof AppError && error.code === 'NETWORK_ADDRESS_BLOCKED');
});

test('URL policy permits private destinations only when explicitly enabled', async () => {
  const policy = new UrlPolicy({ allowPrivateNetworks: true, allowedHosts: ['internal.test', '127.0.0.1', 'localhost'] });
  assert.equal((await policy.assertNavigable('http://127.0.0.1:3000/')).hostname, '127.0.0.1');
  assert.equal((await policy.assertNavigable('http://localhost:3000/')).hostname, 'localhost');
  assert.equal((await policy.assertNavigable('https://internal.test/path')).hostname, 'internal.test');
  await assert.rejects(() => policy.assertNavigable('https://other.test/path'), (error: unknown) => error instanceof AppError && error.code === 'NETWORK_HOST_NOT_ALLOWED');
});
