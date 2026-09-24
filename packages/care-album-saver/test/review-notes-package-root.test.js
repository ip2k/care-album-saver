// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyRootFrom } from '../dist/package-root.js';
import { repositoryRoot } from '../dist/version.js';

/**
 * processes-9's part outside schedule.ts (docs/SECURITY-REVIEW-2026-09-23.md §4.6): environment.ts
 * and version.ts found this copy of the tool by counting three folders up from dist/, which in
 * an npm install is the folder holding node_modules — someone else's project, whose own git
 * clone would then have been read as this tool's.
 */

before(assertIsolatedConfigDir);

async function tree(files) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cas-notes-package-root-')));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

test('processes-9: a clone is its repository root; an npm install is the package, not the project around it', async () => {
  const clone = await tree({
    'package.json': JSON.stringify({ name: 'care-album-saver', private: true }),
    'packages/care-album-saver/package.json': JSON.stringify({ name: 'care-album-saver' }),
    'packages/care-album-saver/dist/cli.js': '',
  });
  const npm = await tree({
    'package.json': JSON.stringify({ name: 'someone-elses-app' }),
    '.git/HEAD': 'ref: refs/heads/main\n',
    'node_modules/care-album-saver/package.json': JSON.stringify({ name: 'care-album-saver' }),
    'node_modules/care-album-saver/dist/cli.js': '',
  });
  const elsewhere = await tree({ 'package.json': JSON.stringify({ name: 'another-tool' }), 'dist/cli.js': '' });
  try {
    assert.equal(copyRootFrom(join(clone, 'packages/care-album-saver/dist')), clone);
    assert.equal(copyRootFrom(join(npm, 'node_modules/care-album-saver/dist')), join(npm, 'node_modules/care-album-saver'));
    assert.equal(copyRootFrom(join(elsewhere, 'dist')), join(elsewhere, 'dist'), 'not this package: its own folder');
    // And this checkout is still found as the clone it is.
    assert.equal(repositoryRoot(), fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, ''));
  } finally {
    for (const dir of [clone, npm, elsewhere]) await rm(dir, { recursive: true, force: true });
  }
});
