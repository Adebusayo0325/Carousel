#!/usr/bin/env node
/**
 * Cross-platform test discovery + runner.
 *
 * Node 20's built-in test runner does not expand `**` globs (that arrived in
 * Node 21), so we walk packages/ and apps/ ourselves and hand explicit file
 * paths to `node --test` via tsx. Keeps `npm test` working on the pinned Node 20
 * without pulling in a glob dependency.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Recursively collect *.test.ts under a directory. */
function collect(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc; // dir doesn't exist yet
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      collect(full, acc);
    } else if (name.endsWith('.test.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

const roots = [join(root, 'packages'), join(root, 'apps')];
const files = roots.flatMap((r) => collect(r, []));

if (files.length === 0) {
  console.error('No test files (*.test.ts) found.');
  process.exit(1);
}

// Allow a filter substring: `npm test -- crypto` runs only matching paths.
const filter = process.argv[2];
const selected = filter ? files.filter((f) => f.includes(filter)) : files;

if (selected.length === 0) {
  console.error(`No test files match filter "${filter}".`);
  process.exit(1);
}

const args = ['--import', 'tsx', '--test', ...selected];
const res = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(res.status ?? 1);
