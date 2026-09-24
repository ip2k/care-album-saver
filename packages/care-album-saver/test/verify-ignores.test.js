import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * scripts/verify-ignores.sh, the check that .gitignore keeps sessions and photos out of a
 * commit, checked in its turn (security review sc-2 and missed-sc, 2026-09-23).
 *
 * Two defects. Its "must still be committable" half asked `git check-ignore`, which never
 * reports a tracked file, so it passed whatever the rules said about README.md or the
 * committed screenshots (sc-2). And its "must be ignored" half created a file of each tested
 * name at the root of the checkout, asked about it and deleted it, so a developer's own
 * gitignored session.json there was overwritten and then removed (missed-sc).
 *
 * Every case runs the script in a throwaway repository under the temp directory, holding a
 * copy of the real .gitignore and stand-ins for the four tracked files the script names:
 * the rules are the real ones, and nothing here touches the developer's checkout. The
 * files planted in it are synthetic text, not sessions.
 *
 * Not on Windows: the script is bash, and security.yml runs it on Linux. On a Windows
 * runner `bash` may be WSL's, which cannot be relied on to see the temp directory.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = 'scripts/verify-ignores.sh';
const RULES = readFileSync(join(ROOT, '.gitignore'), 'utf8');
const posixOnly = { skip: process.platform === 'win32' ? 'the script is bash; security.yml runs it on Linux' : false };

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/**
 * An environment in which git sees only the throwaway repository. A GIT_DIR inherited from a
 * hook, or the developer's own global ignore file, would otherwise decide the answers.
 */
function gitEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...extra };
}

function git(cwd, args, env = gitEnv()) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A repository with the real rules and the script, with its tracked files added. */
function makeRepo() {
  const base = mkdtempSync(join(tmpdir(), 'cas-verify-ignores-'));
  made.push(base);
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'docs', 'images'), { recursive: true });
  writeFileSync(join(repo, '.gitignore'), RULES);
  copyFileSync(join(ROOT, SCRIPT), join(repo, SCRIPT));
  writeFileSync(join(repo, 'README.md'), '# stand-in\n');
  writeFileSync(join(repo, 'docs', 'GUIDE.md'), '# stand-in guide\n');
  writeFileSync(join(repo, 'package.json'), '{ "name": "stand-in" }\n');
  writeFileSync(join(repo, 'docs', 'images', '01-connect.png'), 'not really a PNG\n');
  git(repo, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  // A plain add, so this also shows the real rules let these four files in.
  git(repo, ['add', '--', '.gitignore', SCRIPT, 'README.md', 'docs/GUIDE.md', 'package.json', 'docs/images/01-connect.png']);
  return repo;
}

function run(repo, env = gitEnv()) {
  const r = spawnSync('bash', [SCRIPT], { cwd: repo, env, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Every file and folder under the repository except .git, with each file's bytes and mtime. */
function snapshot(repo) {
  const entries = {};
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      if (rel === '' && name === '.git') continue;
      const path = join(dir, name);
      const key = rel ? `${rel}/${name}` : name;
      const st = lstatSync(path);
      if (st.isDirectory()) {
        entries[`${key}/`] = 'dir';
        walk(path, key);
      } else {
        const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
        entries[key] = `${sha} ${st.mtimeMs} ${st.mode}`;
      }
    }
  };
  walk(repo, '');
  return entries;
}

const status = (repo) => git(repo, ['status', '--porcelain=v1', '--ignored', '--untracked-files=all']);

/** The script's line for one path, so a failure message shows what it said. */
const lineFor = (out, path) => out.split('\n').find((l) => l.includes(` ${path} `)) ?? `(no line for ${path})`;

/** A copy of the real rules with one line replaced, removed (null) or appended. */
function rulesWith(edit) {
  const lines = RULES.split('\n');
  for (const [from, to] of edit) {
    if (from === null) {
      lines.push(to);
      continue;
    }
    const i = lines.indexOf(from);
    assert.ok(i >= 0, `the real .gitignore has a line "${from}"`);
    if (to === null) lines.splice(i, 1);
    else lines[i] = to;
  }
  return lines.join('\n');
}

test('passes on the real rules and leaves the working tree exactly as it was (missed-sc)', posixOnly, () => {
  const repo = makeRepo();
  // A developer's own gitignored files at the root, with the names the script asks about.
  const planted = {
    'session.json': 'a developer\'s own file, standing in for a session\n',
    'config.json': '{ "stand-in": true }\n',
    '.env': 'STAND_IN=1\n',
    'capture.har': '{ "log": "stand-in" }\n',
    'cookies.txt': 'stand-in\n',
    'Care Album Photos/a.jpg': 'not really a photo\n',
  };
  for (const [path, body] of Object.entries(planted)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  const before = snapshot(repo);
  const statusBefore = status(repo);

  const r = run(repo);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /All ignore rules verified\./);
  assert.doesNotMatch(r.out, /FAILED/);

  assert.deepEqual(snapshot(repo), before, 'no file or folder was created, changed or removed');
  assert.equal(status(repo), statusBefore);
  for (const [path, body] of Object.entries(planted)) assert.equal(readFileSync(join(repo, path), 'utf8'), body, path);
});

test('a tracked file that the rules would ignore now fails the check (sc-2)', posixOnly, () => {
  const repo = makeRepo();
  // The screenshots' exception gone, and the README swallowed by a careless rule. Both files
  // stay tracked, which is exactly the state the first version reported as "ok".
  writeFileSync(join(repo, '.gitignore'), rulesWith([['!docs/images/*.png', null], [null, 'README.md']]));
  assert.match(git(repo, ['ls-files']), /^docs\/images\/01-connect\.png$/m, 'still tracked');

  const r = run(repo);
  assert.equal(r.status, 1, r.out);
  assert.match(lineFor(r.out, 'docs/images/01-connect.png'), /FAILED .*tracked, but .*\*\.png ignores it/);
  assert.match(lineFor(r.out, 'docs/images/99-a-new-screenshot.png'), /FAILED .*would refuse it/);
  assert.match(lineFor(r.out, 'README.md'), /FAILED .*tracked, but .*README\.md ignores it/);
  assert.match(lineFor(r.out, 'docs/GUIDE.md'), /^ {2}ok /, 'the others are still judged on their own');
});

test('a name the check expects to be tracked, but is not, fails', posixOnly, () => {
  const repo = makeRepo();
  git(repo, ['rm', '-q', '--cached', '--', 'docs/GUIDE.md']);
  const r = run(repo);
  assert.equal(r.status, 1, r.out);
  assert.match(lineFor(r.out, 'docs/GUIDE.md'), /FAILED .*not tracked/);
});

test('a credential rule that has stopped matching fails, as it did in the first draft', posixOnly, () => {
  const repo = makeRepo();
  // A trailing comment makes the whole line one literal pattern that matches nothing.
  writeFileSync(join(repo, '.gitignore'), rulesWith([['*.har', '*.har  # browser captures'], ['session.json', null]]));
  const r = run(repo);
  assert.equal(r.status, 1, r.out);
  assert.match(lineFor(r.out, 'capture.har'), /FAILED .*would be committable/);
  assert.match(lineFor(r.out, '.never-created/nested/debug.har'), /FAILED .*would be committable/);
  assert.match(lineFor(r.out, 'session.json'), /FAILED .*would be committable/);
  assert.match(lineFor(r.out, 'config.json'), /^ {2}ok /);
});

test('a default archive folder rule that has gone fails, though its photos are still caught by extension', posixOnly, () => {
  for (const [rule, probe] of [['Care*Album*Photos/', 'Care Album Photos/.care-album-saver.lock'], ['Brightwheel*Photos/', 'Brightwheel Photos/.care-album-saver.lock']]) {
    const repo = makeRepo();
    writeFileSync(join(repo, '.gitignore'), rulesWith([[rule, null]]));
    const r = run(repo);
    assert.equal(r.status, 1, r.out);
    assert.match(lineFor(r.out, probe), /FAILED .*would be committable/);
  }
});

test('a rule only in a personal ignore file does not count: it does not travel with a clone', posixOnly, () => {
  const repo = makeRepo();
  writeFileSync(join(repo, '.gitignore'), rulesWith([['session.json', null], ['config.json', null]]));
  // session.json only in this clone's .git/info/exclude; config.json only in a global
  // excludes file named by the developer's own git config.
  writeFileSync(join(repo, '.git', 'info', 'exclude'), 'session.json\n');
  const home = mkdtempSync(join(tmpdir(), 'cas-verify-ignores-home-'));
  made.push(home);
  writeFileSync(join(home, 'ignore'), 'config.json\n');
  writeFileSync(join(home, 'gitconfig'), `[core]\n\texcludesFile = ${join(home, 'ignore')}\n`);
  const env = gitEnv({ GIT_CONFIG_GLOBAL: join(home, 'gitconfig') });
  assert.match(spawnSync('git', ['check-ignore', 'config.json'], { cwd: repo, env, encoding: 'utf8' }).stdout, /config\.json/,
    'the global file really is in effect for plain git');

  const r = run(repo, env);
  assert.equal(r.status, 1, r.out);
  assert.match(lineFor(r.out, 'session.json'), /FAILED .*only a personal rule ignores it/);
  assert.match(lineFor(r.out, 'config.json'), /FAILED .*would be committable/);
});

test('a credential already committed fails, though the rule matches it', posixOnly, () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'session.json'), 'stand-in\n');
  git(repo, ['add', '-f', '--', 'session.json']);
  const r = run(repo);
  assert.equal(r.status, 1, r.out);
  assert.match(lineFor(r.out, 'session.json'), /FAILED .*ignored, but already committed/);
});

test('outside a git checkout it refuses rather than reporting every rule as fine', posixOnly, () => {
  const base = mkdtempSync(join(tmpdir(), 'cas-verify-ignores-nogit-'));
  made.push(base);
  mkdirSync(join(base, 'scripts'));
  copyFileSync(join(ROOT, SCRIPT), join(base, SCRIPT));
  const r = run(base, gitEnv({ GIT_CEILING_DIRECTORIES: dirname(base) }));
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /Not inside a git checkout/);
  assert.doesNotMatch(r.out, /\bok\b/);
});
