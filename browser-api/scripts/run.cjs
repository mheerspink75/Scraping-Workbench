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
    console.error(`[browser-api] ${label} failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function testFiles() {
  const dirs = [
    path.join(root, 'dist-test', 'test', 'unit'),
    path.join(root, 'dist-test', 'test', 'integration'),
  ];
  return dirs.flatMap((directory) => {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter((name) => name.endsWith('.test.js'))
      .sort()
      .map((name) => path.relative(root, path.join(directory, name)));
  });
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
    const files = testFiles().filter((file) => {
      if (command === 'test:unit') return file.includes(`${path.sep}unit${path.sep}`);
      if (command === 'test:integration') return file.includes(`${path.sep}integration${path.sep}`);
      return true;
    });
    if (!files.length) {
      console.error('[browser-api] no compiled test files were found');
      process.exit(1);
    }
    for (const file of files) run(['--test', file], path.basename(file));
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
    console.error(`[browser-api] unknown command: ${command}`);
    process.exit(2);
}
