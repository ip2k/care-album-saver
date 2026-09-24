import { test } from 'node:test';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEVELOPMENT_MARKER, environment, gitCommonDir, PRODUCTION_MARKER } from '../dist/environment.js';

/**
 * Production and development, kept apart. The daily run once pointed at the development
 * checkout, so every build of a branch in progress went live at the next scheduled run.
 *
 * Nothing here turns on a real schedule. A guard that failed under test would register a real
 * launchd job on the machine running the suite, replacing the owner's own; so the guard's
 * place in the code is checked by reading it, and the classification by folders made here.
 */

test('production and development are marked; anything else, a parent\'s clone included, is installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cas-env-'));
  assert.equal(environment(root), 'installed');
  await mkdir(join(root, '.git'));
  assert.equal(environment(root), 'installed', 'a clone made by following the README may set up the daily run');
  await writeFile(join(root, '.git', DEVELOPMENT_MARKER), 'development\n');
  assert.equal(environment(root), 'development');
  await writeFile(join(root, PRODUCTION_MARKER), 'production, deployed before markers named their folder\n');
  assert.equal(environment(root), 'development', 'a marker that names no folder does not make production');
  await writeFile(join(root, PRODUCTION_MARKER), `${tmpdir()}\nproduction\n`);
  assert.equal(environment(root), 'development', 'nor does one that names another folder: a copy of production');
  await writeFile(join(root, PRODUCTION_MARKER), `${root}\nproduction\n`);
  assert.equal(environment(root), 'production', 'the production mark, naming its own folder, wins');
});

test('every worktree of the development checkout is development, through git\'s common folder', async () => {
  const main = await mkdtemp(join(tmpdir(), 'cas-env-main-'));
  const own = join(main, '.git', 'worktrees', 'review');
  await mkdir(own, { recursive: true });
  await writeFile(join(own, 'commondir'), '../..\n');
  const worktree = await mkdtemp(join(tmpdir(), 'cas-env-wt-'));
  await writeFile(join(worktree, '.git'), `gitdir: ${own}\n`);
  assert.equal(gitCommonDir(worktree), join(main, '.git'));
  assert.equal(environment(worktree), 'installed', 'a worktree of somebody\'s own clone is theirs');
  await writeFile(join(main, '.git', DEVELOPMENT_MARKER), 'development\n');
  assert.equal(environment(worktree), 'development', 'an agent building a branch in a worktree cannot reach the real scheduler');
});

test('deploy.js marks the checkout it deploys from, inside git\'s folder rather than the tree', async () => {
  const deploy = (await readFile(fileURLToPath(new URL('../../../scripts/deploy.js', import.meta.url)), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(deploy, /const DEVELOPMENT_MARKER = 'care-album-saver-development';/);
  assert.equal(DEVELOPMENT_MARKER, 'care-album-saver-development', 'the script and the tool agree on the name');
  assert.match(deploy, /--git-common-dir/);
});

test('the checkout the suite runs in is classified by its marks, and never by having a .git', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const common = gitCommonDir(root);
  const expected = existsSync(join(root, PRODUCTION_MARKER)) ? 'production'
    : common && existsSync(join(common, DEVELOPMENT_MARKER)) ? 'development'
    : 'installed';
  assert.equal(environment(), expected);
});

test('the daily run is refused from development before the scheduler can be reached', async () => {
  const server = (await readFile(fileURLToPath(new URL('../src/web/server.ts', import.meta.url)), 'utf8')).replace(/\r\n/g, '\n');
  const route = server.slice(server.indexOf("url.pathname === '/api/schedule') {\n        const { time"));
  const guard = route.indexOf("environment() === 'development'");
  const install = route.indexOf('schedule.install(');
  assert.ok(guard > 0 && install > guard, 'the page checks the environment before installing');

  const cli = (await readFile(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'utf8')).replace(/\r\n/g, '\n');
  const on = cli.slice(cli.indexOf("if (what === 'on') {"));
  assert.ok(on.indexOf("environment() === 'development'") < on.indexOf('schedule.install('), 'and so does the command line');
});

test('the demo says which branch it is showing', async () => {
  const demo = (await readFile(fileURLToPath(new URL('../../../scripts/demo.js', import.meta.url)), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(demo, /Demo of \$\{branch\}/);
});
