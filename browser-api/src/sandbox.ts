/**
 * User code is evaluated in a fresh QuickJS WASM context, never in the live
 * Playwright page realm. The page adapter supplies only bounded JSON data.
 */
import { getQuickJS, type QuickJSHandle } from 'quickjs-emscripten';
import { parse } from 'acorn';
import { AppError } from './errors.js';

interface AstNode {
  type: string;
  [key: string]: unknown;
}

export interface SandboxDocument {
  url: string;
  title: string;
  bodyText: string;
  elements: Array<{
    tag: string;
    id?: string;
    text: string;
    attributes: Record<string, string | boolean>;
  }>;
}

let quickJsPromise: ReturnType<typeof getQuickJS> | undefined;

function loadQuickJs() {
  quickJsPromise ??= getQuickJS();
  return quickJsPromise;
}

const forbiddenIdentifiers = new Set([
  'window', 'self', 'globalThis', 'top', 'parent', 'frames', 'fetch', 'XMLHttpRequest',
  'WebSocket', 'EventSource', 'navigator', 'location', 'localStorage', 'sessionStorage',
  'indexedDB', 'caches', 'cookieStore', 'chrome', 'browser', 'webkit', 'Worker',
  'SharedWorker', 'ServiceWorker', 'importScripts', 'postMessage', 'requestAnimationFrame',
  'cancelAnimationFrame', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout',
  'clearInterval', 'clearImmediate', 'crypto', 'performance', 'history', 'screen',
  'Notification', 'WebAssembly', 'SharedArrayBuffer', 'Atomics', 'Reflect', 'Proxy',
  'eval', 'Function', 'require', 'process', 'module', 'exports', 'global', 'Deno', 'Bun',
  'Promise', 'Object', 'Array', 'Error', 'TypeError', 'RangeError', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Intl', 'encodeURIComponent', 'decodeURIComponent',
  'parseInt', 'parseFloat', 'isFinite', 'isNaN', 'console', 'alert', 'confirm', 'prompt', 'open', 'print',
]);

const forbiddenProperties = new Set([
  'constructor', '__proto__', 'prototype', 'caller', 'callee', 'cookie', 'localStorage',
  'sessionStorage', 'indexedDB', 'caches', 'fetch', 'open', 'send', 'submit',
  'postMessage', 'importScripts', 'getCookies', 'chrome', 'browser', 'webkit',
]);

const forbiddenCalls = new Set([
  'eval', 'Function', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'open',
  'send', 'setTimeout', 'setInterval', 'setImmediate', 'requestAnimationFrame',
  'postMessage', 'importScripts', 'require',
]);

function walk(
  node: AstNode,
  visitor: (node: AstNode) => void,
  state = { count: 0 },
  parent?: AstNode,
  parentKey?: string,
): void {
  state.count += 1;
  if (state.count > 5_000) throw new AppError(400, 'EVAL_TOO_COMPLEX', 'The evaluation script is too complex.');
  const isPropertyName = (
    (parent?.type === 'MemberExpression' && parentKey === 'property' && parent.computed !== true)
    || (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent?.type || '') && parentKey === 'key' && parent?.computed !== true)
  );
  if (!isPropertyName) visitor(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    if (key === 'key' && ['Property', 'MethodDefinition', 'PropertyDefinition'].includes(node.type) && node.computed !== true) continue;
    if (key === 'property' && node.type === 'MemberExpression' && node.computed !== true) continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && 'type' in child) walk(child as AstNode, visitor, state, node, key);
      }
    } else if (value && typeof value === 'object' && 'type' in value) {
      walk(value as AstNode, visitor, state, node, key);
    }
  }
}

function propertyName(node: AstNode): string | undefined {
  const property = node.property;
  if (!property || typeof property !== 'object') return undefined;
  const record = property as AstNode;
  if (record.type === 'Identifier' && typeof record.name === 'string') return record.name;
  if (record.type === 'Literal' && typeof record.value === 'string') return record.value;
  return undefined;
}

export function validateSandboxScript(code: string): void {
  if (Buffer.byteLength(code, 'utf8') > 50_000) {
    throw new AppError(400, 'EVAL_TOO_LARGE', 'The evaluation script is too large.');
  }
  let ast: AstNode;
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as AstNode;
  } catch (error) {
    throw new AppError(400, 'EVAL_SYNTAX_ERROR', error instanceof Error ? error.message : 'Invalid JavaScript syntax.');
  }

  walk(ast, (node) => {
    if (
      node.type === 'ThisExpression'
      || node.type === 'WithStatement'
      || node.type === 'DebuggerStatement'
      || node.type === 'ImportExpression'
      || node.type === 'MetaProperty'
      || node.type === 'AwaitExpression'
      || node.type === 'YieldExpression'
      || ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && node.async === true)
    ) {
      throw new AppError(403, 'EVAL_FORBIDDEN_CONSTRUCT', 'This JavaScript construct is not allowed in the sandbox.');
    }
    if (node.type === 'Identifier' && typeof node.name === 'string' && forbiddenIdentifiers.has(node.name)) {
      throw new AppError(403, 'EVAL_FORBIDDEN_IDENTIFIER', `The identifier ${node.name} is not available in the sandbox.`);
    }
    if (node.type === 'MemberExpression') {
      const property = node.property as AstNode | undefined;
      if (node.computed && property?.type !== 'Literal') {
        throw new AppError(403, 'EVAL_FORBIDDEN_PROPERTY', 'Computed property names are not available in the sandbox.');
      }
      const name = propertyName(node);
      if (name && forbiddenProperties.has(name)) {
        throw new AppError(403, 'EVAL_FORBIDDEN_PROPERTY', `The property ${name} is not available in the sandbox.`);
      }
    }
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      if (node.type === 'NewExpression') {
        throw new AppError(403, 'EVAL_FORBIDDEN_CONSTRUCT', 'Constructors are not available in the sandbox.');
      }
      const callee = node.callee;
      if (callee && typeof callee === 'object') {
        const record = callee as AstNode;
        if (record.type === 'Identifier' && typeof record.name === 'string' && forbiddenCalls.has(record.name)) {
          throw new AppError(403, 'EVAL_FORBIDDEN_CALL', `The function ${record.name} is not available in the sandbox.`);
        }
        if (record.type === 'MemberExpression') {
          const name = propertyName(record);
          if (name && forbiddenCalls.has(name)) {
            throw new AppError(403, 'EVAL_FORBIDDEN_CALL', `The function ${name} is not available in the sandbox.`);
          }
        }
      }
    }
  });
}

const bootstrap = String.raw`
  const source = JSON.parse(__SANDBOX_DOCUMENT__);
  const freeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
    return value;
  };
  const makeNode = (raw) => {
    const attrs = Object.create(null);
    for (const [key, value] of Object.entries(raw.attributes || {})) attrs[key] = value;
    const node = {
      tag: String(raw.tag || '').toLowerCase(),
      id: raw.id ? String(raw.id) : undefined,
      text: String(raw.text || ''),
      attributes: freeze(attrs),
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
      hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    };
    return freeze(node);
  };
  const nodes = Object.freeze(source.elements.map(makeNode));
  const parseSelector = (raw) => {
    const match = String(raw || '').trim().match(/^([a-z][a-z0-9-]*)?(?:#([a-z0-9_-]+))?(?:\.([a-z0-9_-]+))?(?:\[([a-z0-9:_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\])?$/i);
    if (!match) return null;
    return { tag: match[1] ? match[1].toLowerCase() : null, id: match[2] || null, className: match[3] || null, attribute: match[4] || null, value: match[5] ?? match[6] ?? match[7] ?? null };
  };
  const matches = (node, selector) => String(selector || '').split(',').some((part) => {
    const parsed = parseSelector(part);
    if (!parsed) return false;
    if (parsed.tag && node.tag !== parsed.tag) return false;
    if (parsed.id && node.id !== parsed.id) return false;
    if (parsed.className && !String(node.attributes.class || '').split(/\s+/).includes(parsed.className)) return false;
    if (parsed.attribute && !node.hasAttribute(parsed.attribute)) return false;
    if (parsed.attribute && parsed.value !== null && String(node.getAttribute(parsed.attribute)) !== parsed.value) return false;
    return true;
  });
  const document = {
    title: String(source.title || ''),
    URL: String(source.url || ''),
    bodyText: String(source.bodyText || ''),
    elements: nodes,
    querySelector(selector) { return nodes.find((node) => matches(node, selector)) || null; },
    querySelectorAll(selector) { return Object.freeze(nodes.filter((node) => matches(node, selector))); },
    getElementById(id) { return nodes.find((node) => node.id === id) || null; },
  };
  Object.defineProperty(this, 'document', { value: freeze(document), writable: false, configurable: false });
  const blocked = ['window','self','globalThis','top','parent','frames','fetch','XMLHttpRequest','WebSocket','EventSource','navigator','location','localStorage','sessionStorage','indexedDB','caches','cookieStore','chrome','browser','webkit','Worker','SharedWorker','ServiceWorker','importScripts','postMessage','requestAnimationFrame','cancelAnimationFrame','setTimeout','setInterval','setImmediate','clearTimeout','clearInterval','clearImmediate','crypto','performance','history','screen','Notification','WebAssembly','SharedArrayBuffer','Atomics','Reflect','Proxy','eval','Function','require','process','module','exports','global','Deno','Bun','Promise','console','alert','confirm','prompt','open','print'];
  for (const name of blocked) {
    try { Object.defineProperty(this, name, { value: undefined, writable: false, configurable: false }); } catch (_) {}
  }
  for (const name of ['Object','Array','String','Number','Boolean','RegExp','Date','Math','JSON','Intl']) {
    try { if (this[name]) { Object.freeze(this[name]); if (this[name].prototype) Object.freeze(this[name].prototype); } } catch (_) {}
  }
`;

export async function runSandboxedScript(
  code: string,
  documentModel: SandboxDocument,
  timeoutMs = 250,
): Promise<unknown> {
  validateSandboxScript(code);
  const QuickJS = await loadQuickJs();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + Math.max(10, timeoutMs);
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  const serialized = JSON.stringify(documentModel);
  const documentLiteral = JSON.stringify(serialized);
  const setup = bootstrap.replace('__SANDBOX_DOCUMENT__', () => documentLiteral);

  const errorMessage = (handle: QuickJSHandle): string => {
    const dumped = context.dump(handle);
    if (typeof dumped === 'string') return dumped.slice(0, 500);
    if (dumped && typeof dumped === 'object') {
      const message = (dumped as { message?: unknown }).message;
      if (typeof message === 'string') return message.slice(0, 500);
    }
    return 'Evaluation failed.';
  };

  try {
    const setupResult = context.evalCode(setup, 'sandbox-bootstrap.js', { type: 'global' });
    if (setupResult.error) {
      const message = errorMessage(setupResult.error);
      setupResult.error.dispose();
      throw new AppError(500, 'SANDBOX_BOOTSTRAP_FAILED', message);
    }
    setupResult.value.dispose();

    const userResult = context.evalCode(`"use strict";\n${code}`, 'browser-eval.js', { type: 'global' });
    if (userResult.error) {
      const message = errorMessage(userResult.error);
      userResult.error.dispose();
      if (/interrupt/i.test(message)) throw new AppError(408, 'EVAL_TIMEOUT', 'The evaluation script exceeded its time limit.');
      throw new AppError(400, 'EVAL_FAILED', message);
    }
    context.setProp(context.global, '__sandbox_result__', userResult.value);
    userResult.value.dispose();

    const serializedResult = context.evalCode('JSON.stringify(__sandbox_result__)', 'sandbox-serialize.js', { type: 'global' });
    if (serializedResult.error) {
      const message = errorMessage(serializedResult.error);
      serializedResult.error.dispose();
      if (/interrupt/i.test(message)) throw new AppError(408, 'EVAL_TIMEOUT', 'The evaluation script exceeded its time limit.');
      throw new AppError(400, 'EVAL_RESULT_INVALID', 'The evaluation result could not be serialized safely.');
    }
    const resultType = context.typeof(serializedResult.value);
    const serializedValue = resultType === 'undefined' ? undefined : context.getString(serializedResult.value);
    serializedResult.value.dispose();
    if (serializedValue === undefined) return null;
    if (Buffer.byteLength(serializedValue, 'utf8') > 1_000_000) {
      throw new AppError(413, 'EVAL_RESULT_TOO_LARGE', 'The evaluation result is too large.');
    }
    return JSON.parse(serializedValue) as unknown;
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
