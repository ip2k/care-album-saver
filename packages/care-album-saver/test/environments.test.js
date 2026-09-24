import { test } from 'node:test';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { environment, PRODUCTION_MARKER } from '../dist/environment.js';

/**
 * Production and development, kept apart. The daily run once pointed at the development
 * checkout, so every build of a branch in progress went live at the next scheduled run.
 *
 * Nothing here turns on a real schedule. A guard that failed under test would register a real
 * launchd job on the machine running the suite, replacing the owner's own; so the guard's
 * place in the code is checked by reading it, and the classification by folders made here.
 */

test('a deployed clone is production, any other checkout is development, anything else is installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cas-env-'));
  assert.equal(environment(root), 'installed');
  await mkdir(join(root, '.git'));
  assert.equal(environment(root), 'development');
  await writeFile(join(root, PRODUCTION_MARKER), 'production\n');
  assert.equal(environment(root), 'production', 'the marker wins over .git');

  const worktree = await mkdtemp(join(tmpdir(), 'cas-env-wt-'));
  await writeFile(join(worktree, '.git'), 'gitdir: /somewhere/else\n');
  assert.equal(environment(worktree), 'development', 'a worktree, whose .git is a file, is development too');
});

test('the checkout the suite runs in is development, or production once deploy.js has marked it', () => {
  // The suite runs in both: here, and in the production clone, where deploy.js runs it before
  // anything is switched over. Asserting "development" alone made every deploy after the
  // first fail, because by then production carries its marker.
  const marked = existsSync(join(fileURLToPath(new URL('../../../', import.meta.url)), PRODUCTION_MARKER));
  assert.equal(environment(), marked ? 'production' : 'development');
});

test('the daily run is refused from development before the scheduler can be reached', async () => {
  const server = await readFile(fileURLToPath(new URL('../src/web/server.ts', import.meta.url)), 'utf8');
  const route = server.slice(server.indexOf("url.pathname === '/api/schedule') {\n        const { time }"));
  const guard = route.indexOf("environment() === 'development'");
  const install = route.indexOf('schedule.install(');
  assert.ok(guard > 0 && install > guard, 'the page checks the environment before installing');

  const cli = await readFile(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'utf8');
  const on = cli.slice(cli.indexOf("if (what === 'on') {"));
  assert.ok(on.indexOf("environment() === 'development'") < on.indexOf('schedule.install('), 'and so does the command line');
});

test('the demo says which branch it is showing', async () => {
  const demo = await readFile(fileURLToPath(new URL('../../../scripts/demo.js', import.meta.url)), 'utf8');
  assert.match(demo, /Demo of \$\{branch\}/);
});
