import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * The `care-album-saver` command, from a clone (2026-10-01). The README told parents to run
 * `pnpm link --global`, which pnpm 12 no longer has, so the documented way to type
 * `care-album-saver` in any folder failed. The clone's instructions now link it with npm,
 * which comes with Node and links the folder rather than copying it, so updating the clone
 * updates the command. A link to dist/cli.js needs that file to be executable, and a build
 * from scratch (`pnpm clean`, or deploy.js putting production back) used to write it without
 * the bit, so the command answered "permission denied"; the build now sets it.
 */

const ROOT = new URL('../../../', import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), 'utf8');
const LINK = 'npm install -g ./packages/care-album-saver';

test('the build leaves the command executable, so a link to it survives a build from scratch', async () => {
  const { scripts } = JSON.parse(await read('package.json'));
  assert.match(scripts.build, /^tsc --build && node -e "require\('node:fs'\)\.chmodSync\('packages\/care-album-saver\/dist\/cli\.js', 0o755\)"$/);
  const { bin } = JSON.parse(await read('packages/care-album-saver/package.json'));
  assert.deepEqual(bin, { 'care-album-saver': 'dist/cli.js' }, 'the file the build marks is the one npm links');
  assert.match(await read('packages/care-album-saver/src/cli.ts'), /^#!\/usr\/bin\/env node\n/, 'and it says how to run it');
  // The suite runs after a build, in CI and in deploy.js alike. Windows has no such bit.
  if (process.platform !== 'win32') {
    const { mode } = await stat(fileURLToPath(new URL('packages/care-album-saver/dist/cli.js', ROOT)));
    assert.equal(mode & 0o111, 0o111, `dist/cli.js is ${(mode & 0o777).toString(8)}`);
  }
});

for (const [doc, block] of [
  ['README.md', /\*\*From a clone\*\*, six commands, once:\n\n```sh\n([\s\S]*?)```/],
  ['docs/GUIDE.md', /## Step 1[\s\S]*?```sh\n([\s\S]*?)```/],
]) {
  test(`${doc}: installing from a clone links the command, then starts it by name`, async () => {
    const text = await read(doc);
    const lines = block.exec(text)?.[1].trim().split('\n');
    assert.ok(lines, 'the clone commands are where they were');
    assert.deepEqual(lines, [
      'git clone https://github.com/ip2k/care-album-saver.git',
      'cd care-album-saver',
      'pnpm install',
      'pnpm build',
      LINK,
      'care-album-saver setup',
    ]);
  });
}

test('nothing tells anyone to run `pnpm link --global`, and the README says what to do when npm cannot link', async () => {
  for (const doc of ['README.md', 'docs/GUIDE.md', 'docs/UPDATING.md']) {
    const text = await read(doc);
    assert.doesNotMatch(text, /run `pnpm link --global`/, doc);
    assert.doesNotMatch(text, /^pnpm link --global/m, doc);
  }
  const readme = await read('README.md');
  assert.match(readme, /pnpm 12 has no `pnpm link --global`/, 'it says why it is npm');
  assert.match(readme, /docs\.npmjs\.com\/resolving-eacces-permissions-errors-when-installing-packages-globally/);
  assert.match(readme, /`npm uninstall -g care-album-saver` removes the command and leaves the clone alone\./);
  assert.match(await read('docs/UPDATING.md'), /is a link to this folder, so it has nothing to\nredo either\./);
});
