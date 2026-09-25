#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = process.env.npm_config_local_prefix || process.cwd();
const invokedAsScript = Boolean(process.argv[1] && path.basename(process.argv[1]) === 'run.cjs');
const command = (invokedAsScript ? process.argv[2] : process.argv[1]) || 'build';
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

function run(args, label = args[0]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error(`[copilot-bridge] ${label} failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function testFiles(directory) {
  const testDirectory = path.join(root, 'dist-test', 'test', directory);
  if (!fs.existsSync(testDirectory)) return [];
  return fs.readdirSync(testDirectory)
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => path.relative(root, path.join(testDirectory, name)));
}

switch (command) {
  case 'build':
    run([tsc, '-p', path.join(root, 'tsconfig.json')], 'build');
    break;
  case 'lint':
    run([tsc, '-p', path.join(root, 'tsconfig.json'), '--noEmit'], 'lint');
    break;
  case 'test':
  case 'test:unit':
  case 'test:integration': {
    run([tsc, '-p', path.join(root, 'tsconfig.test.json')], 'test compilation');
    const directories = command === 'test:unit'
      ? ['unit']
      : command === 'test:integration'
        ? ['integration']
        : ['unit', 'integration'];
    for (const directory of directories) {
      for (const file of testFiles(directory)) run(['--test', file], path.basename(file));
    }
    break;
  }
  case 'start':
    run([path.join(root, 'dist', 'index.js')], 'server');
    break;
  case 'dev':
    run([tsc, '-p', path.join(root, 'tsconfig.json')], 'build');
    run(['--watch', path.join(root, 'dist', 'index.js')], 'server');
    break;
  default:
    console.error(`[copilot-bridge] unknown command: ${command}`);
    process.exit(2);
}
