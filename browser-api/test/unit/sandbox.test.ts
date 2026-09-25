import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../../src/errors.js';
import { runSandboxedScript } from '../../src/sandbox.js';

const model = {
  url: 'https://example.test/page',
  title: 'Example title',
  bodyText: 'Visible text',
  elements: [
    { tag: 'h1', id: 'heading', text: 'Example title', attributes: { class: 'title' } },
    { tag: 'a', text: 'Link', attributes: { href: 'https://example.test/next', class: 'link' } },
  ],
};

async function rejects(code: string, script: string): Promise<void> {
  await assert.rejects(() => runSandboxedScript(script, model, 100), (error: unknown) => error instanceof AppError && error.code === code);
}

test('sandbox exposes only a read-only page model', async () => {
  assert.equal(await runSandboxedScript('1 + 2', model, 100), 3);
  assert.equal(await runSandboxedScript('document.title', model, 100), 'Example title');
  assert.equal(await runSandboxedScript('document.querySelector("#heading").text', model, 100), 'Example title');
  assert.deepEqual(await runSandboxedScript('document.querySelectorAll("a.link").map((item) => item.getAttribute("href"))', model, 100), ['https://example.test/next']);
});

test('sandbox blocks browser capabilities and escape-oriented constructs', async () => {
  await rejects('EVAL_FORBIDDEN_IDENTIFIER', 'window');
  await rejects('EVAL_FORBIDDEN_IDENTIFIER', 'localStorage.getItem("x")');
  await rejects('EVAL_FORBIDDEN_IDENTIFIER', 'process.env');
  await rejects('EVAL_FORBIDDEN_CALL', 'require("fs")');
  await rejects('EVAL_FORBIDDEN_CALL', 'fetch("https://example.test")');
  await rejects('EVAL_FORBIDDEN_PROPERTY', 'document.cookie');
  await rejects('EVAL_FORBIDDEN_PROPERTY', 'document.body.constructor');
  await rejects('EVAL_FORBIDDEN_CONSTRUCT', 'this');
  await rejects('EVAL_FORBIDDEN_CALL', 'Function("return 1")()');
  await rejects('EVAL_FORBIDDEN_CALL', 'document.querySelector("h1").open()');
  await rejects('EVAL_FORBIDDEN_CONSTRUCT', 'async function f() { return 1; }');
});

test('sandbox enforces time, memory, and result-serialization limits', async () => {
  await assert.rejects(() => runSandboxedScript('while (true) {}', model, 10), (error: unknown) => error instanceof AppError && error.code === 'EVAL_TIMEOUT');
  await assert.rejects(() => runSandboxedScript(`"${'x'.repeat(51_000)}"`, model, 100), (error: unknown) => error instanceof AppError && error.code === 'EVAL_TOO_LARGE');
  await assert.rejects(() => runSandboxedScript('({toJSON: () => { while (true) {} }})', model, 10), (error: unknown) => error instanceof AppError && error.code === 'EVAL_TIMEOUT');
  await assert.rejects(() => runSandboxedScript('(() => { const x = {}; x.self = x; return x; })()', model, 100), (error: unknown) => error instanceof AppError && error.code === 'EVAL_RESULT_INVALID');
});
