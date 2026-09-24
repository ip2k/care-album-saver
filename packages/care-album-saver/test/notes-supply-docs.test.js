// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, writeSecureFile } from '../dist/index.js';

/**
 * The security review's NOTEs for the supply chain and the documents (docs/SECURITY-REVIEW-
 * 2026-09-23.md §4.3), the ones a test can hold: sc-8, sc-11, sc-12, sc-13 and docs-9. The
 * Docker and workflow ones are in dockerfile.test.js and workflows.test.js; deploy.js's
 * failure message and the demo and screenshot scripts' folders have files of their own.
 */

assertIsolatedConfigDir();

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const posixOnly = { skip: process.platform === 'win32' ? 'Windows has no POSIX modes; the ACL is inherited instead' : false };

/** A git environment that sees only the repository asked about, not a hook's GIT_DIR. */
function gitEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
}

// ------------------------------------------------------------------ sc-11: the marks

const MARKS = ['.care-album-saver-production', 'care-album-saver-development'];

/** The tracked paths that carry a production or development mark's name, at any depth. */
function trackedMarks(repo) {
  const r = spawnSync('git', ['ls-files', '-z', '--cached'], { cwd: repo, env: gitEnv(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\0').filter((path) => MARKS.includes(basename(path)));
}

const isCheckout = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, env: gitEnv(), encoding: 'utf8' }).stdout.trim() === 'true';

test('neither mark is ever committed, whatever `git add -f` was given (sc-11)', { skip: isCheckout ? false : 'not a git checkout' }, () => {
  // deploy.js writes the production mark into the production clone and the development mark
  // inside .git; .gitignore refuses both names, but `git add -f` gets past any ignore rule.
  // A committed production mark would make every clone of the repository "production".
  assert.deepEqual(trackedMarks(ROOT), []);
});

test('and the check sees one that was forced in', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'cas-notes-marks-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=stand-in', '-c', 'user.email=stand-in@example.invalid', ...args], { cwd: repo, env: gitEnv(), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q');
  await writeFile(join(repo, '.gitignore'), `${MARKS.join('\n')}\n`);
  await mkdir(join(repo, 'nested'));
  await writeFile(join(repo, '.care-album-saver-production'), '/somewhere\nproduction\n');
  await writeFile(join(repo, 'nested', 'care-album-saver-development'), 'development\n');
  git('add', '.gitignore');
  assert.deepEqual(trackedMarks(repo), [], 'the ignore rules keep a plain add out');
  git('add', '-f', '--', '.care-album-saver-production', 'nested/care-album-saver-development');
  assert.deepEqual(trackedMarks(repo).sort(), ['.care-album-saver-production', 'nested/care-album-saver-development']);
});

// ------------------------------------------------------------------ sc-12: launch.json

test('the tracked launch.json starts only the demo, never a copy with real settings (sc-12)', () => {
  // A launch entry is one preview_start away from any agent working in this repository. The
  // production-setup entry started the owner's real setup page, with the real session behind
  // it; the owner starts that one by hand, with `node scripts/production.js setup`.
  const { configurations } = JSON.parse(read('.claude/launch.json'));
  assert.ok(configurations.length >= 1);
  for (const c of configurations) {
    const command = [c.runtimeExecutable, ...(c.runtimeArgs ?? [])].join(' ');
    assert.equal(c.runtimeExecutable, 'node', command);
    assert.equal(c.runtimeArgs?.[0], 'scripts/demo.js', `"${c.name}" runs ${command}, which is not the throwaway demo`);
  }
});

// ------------------------------------------------------------------ sc-13: the oldest Node

test('the oldest supported Node is the same everywhere it is named (sc-13)', () => {
  const root = JSON.parse(read('package.json'));
  const pkg = JSON.parse(read('packages/care-album-saver/package.json'));
  assert.equal(root.engines.node, pkg.engines.node);
  const oldest = Number(/^>=(\d+)$/.exec(pkg.engines.node)?.[1]);
  assert.ok(oldest >= 22, `engines says ${pkg.engines.node}; the only dependency, exiftool-vendored, needs 22`);

  // The CI matrix starts there, and nothing else in CI runs older.
  const ci = read('.github/workflows/ci.yml');
  const matrix = /^\s+node:\s*\[([^\]]+)\]/m.exec(ci)?.[1].split(',').map((n) => Number(n.trim()));
  assert.ok(matrix?.length, 'ci.yml has a node matrix');
  assert.equal(Math.min(...matrix), oldest, `the matrix ${matrix.join(', ')} starts at the oldest supported Node`);
  for (const file of ['ci.yml', 'release.yml', 'security.yml']) {
    for (const [, v] of read(`.github/workflows/${file}`).matchAll(/node-version:\s*(\d+)/g)) {
      assert.ok(Number(v) >= oldest, `${file} runs Node ${v}`);
    }
  }
  // The image, both stages.
  const images = [...read('Dockerfile').matchAll(/^FROM node:(\d+)/gm)].map((m) => Number(m[1]));
  assert.equal(images.length, 2);
  for (const v of images) assert.ok(v >= oldest, `the Dockerfile builds on Node ${v}`);
  // The type definitions are the oldest Node's, so an API newer than that cannot compile.
  assert.equal(Number(/(\d+)/.exec(root.devDependencies['@types/node'])?.[1]), oldest);

  // What the documents tell a parent, and the versions they say CI tests.
  for (const doc of ['README.md', 'docs/GUIDE.md']) {
    const said = [...read(doc).matchAll(/Node (\d+) or newer/g)].map((m) => Number(m[1]));
    assert.ok(said.length >= 1, `${doc} says which Node it needs`);
    for (const v of said) assert.equal(v, oldest, `${doc} says Node ${v} or newer`);
  }
  const tested = [...read('README.md').matchAll(/Node (\d+), (\d+) and (\d+)/g)].map((m) => m.slice(1).map(Number));
  assert.ok(tested.length >= 1);
  for (const list of tested) assert.deepEqual(list, matrix, 'the README names the versions CI runs');
});

// ------------------------------------------------------------------ sc-8: why each install is as it is

test('every pnpm install in the Dockerfile, the workflows and deploy.js says why its flags are what they are (sc-8)', () => {
  const files = ['Dockerfile', 'scripts/deploy.js', ...['ci.yml', 'release.yml', 'security.yml'].map((f) => `.github/workflows/${f}`)];
  let installs = 0;
  for (const file of files) {
    const lines = read(file).split('\n');
    lines.forEach((line, i) => {
      if (!/\bpnpm install\b|'pnpm', \['install'/.test(line) || /^\s*(#|\/\/|\*)/.test(line)) return;
      installs += 1;
      const above = lines.slice(0, i).reverse().find((l) => l.trim() !== '') ?? '';
      assert.match(above, /^\s*(#|\/\/)/, `${file}:${i + 1} ${line.trim()} has no comment above it`);
    });
  }
  assert.ok(installs >= 7, `found ${installs}`);
});

// ------------------------------------------------------------------ docs-9: the config folder's mode

test('a config folder that already existed is made owner-only at the first write (docs-9)', posixOnly, async (t) => {
  const previous = process.env.CARE_ALBUM_CONFIG_DIR;
  t.after(() => { process.env.CARE_ALBUM_CONFIG_DIR = previous; });
  for (const before of [0o755, 0o750, 0o711, 0o770]) {
    const dir = await mkdtemp(join(tmpdir(), 'cas-notes-config-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await chmod(dir, before);
    process.env.CARE_ALBUM_CONFIG_DIR = dir;
    await writeSecureFile(configPath(), '{}');
    assert.equal((await stat(dir)).mode & 0o777, 0o700, `a folder at ${before.toString(8)}`);
    assert.equal((await stat(configPath())).mode & 0o777, 0o600);
  }
});

test('one already stricter, or one that is not the config folder, is left as it is', posixOnly, async (t) => {
  const previous = process.env.CARE_ALBUM_CONFIG_DIR;
  t.after(() => { process.env.CARE_ALBUM_CONFIG_DIR = previous; });
  const config = await mkdtemp(join(tmpdir(), 'cas-notes-config-'));
  const other = await mkdtemp(join(tmpdir(), 'cas-notes-other-'));
  t.after(() => Promise.all([config, other].map((d) => rm(d, { recursive: true, force: true }))));
  process.env.CARE_ALBUM_CONFIG_DIR = config;

  await chmod(config, 0o700);
  await writeSecureFile(configPath(), '{}');
  assert.equal((await stat(config)).mode & 0o777, 0o700);

  // writeSecureFile is exported: a caller writing somewhere else does not get that folder's
  // mode changed under it.
  await chmod(other, 0o755);
  await writeSecureFile(join(other, 'x.json'), '{}');
  assert.equal((await stat(other)).mode & 0o777, 0o755);
  assert.equal((await stat(join(other, 'x.json'))).mode & 0o777, 0o600);
});

test('and the home folder is never narrowed, even named as the config folder', posixOnly, async (t) => {
  const previous = { config: process.env.CARE_ALBUM_CONFIG_DIR, home: process.env.HOME };
  t.after(() => {
    process.env.CARE_ALBUM_CONFIG_DIR = previous.config;
    process.env.HOME = previous.home;
  });
  // A stand-in home: os.homedir() reads HOME, so the real one is never touched.
  const home = await mkdtemp(join(tmpdir(), 'cas-notes-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await chmod(home, 0o755);
  process.env.HOME = home;
  process.env.CARE_ALBUM_CONFIG_DIR = home;
  await writeSecureFile(configPath(), '{}');
  assert.equal((await stat(home)).mode & 0o777, 0o755);
  assert.equal((await stat(configPath())).mode & 0o777, 0o600);
  assert.ok(existsSync(configPath()));
});
