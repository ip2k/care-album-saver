// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * scripts/deploy.js, once production is updated and marked, when moving the daily run fails
 * (security review sc-8, 2026-09-24).
 *
 * Both of the last steps can fail after the markers are written: reading the saved time, and
 * `schedule on`. The first used to throw straight out of the script; the second still did,
 * as execFileSync's stack trace, with nothing saying that production was deployed but the
 * daily run was not moved. Each now ends in a sentence that says so and how to try again.
 *
 * Every case runs a copy of deploy.js in a throwaway repository, deploying to a throwaway
 * production folder, with stand-ins for everything it starts: a `pnpm` that does nothing, an
 * `npm` that writes down what it was asked and links like npm would, inside the throwaway
 * folder, and a dist/ whose config.js and cli.js only say what the case needs. Nothing here
 * reaches a real scheduler, setting, checkout or global npm folder: the stand-in npm is first
 * on the PATH in every case, and scripts/test-env.js's CARE_ALBUM_NO_GLOBAL_LINK keeps
 * deploy.js from asking npm at all unless a case lifts it.
 *
 * Not on Windows: the stand-in pnpm is a shell script, and deploy.js starts `pnpm` by name,
 * which on Windows is pnpm.cmd and needs a shell; production there is not a supported setup.
 */

assertIsolatedConfigDir();

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const posixOnly = { skip: process.platform === 'win32' ? 'deploy.js starts pnpm by name; on Windows that is a .cmd' : false };

/** A git environment that sees only the throwaway repositories. */
function gitEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
}

/**
 * A development repository holding deploy.js and a stand-in dist/, on `main`, and the bin
 * folder with the stand-in pnpm. `config` and `cli` are the bodies of dist/config.js and
 * dist/cli.js.
 */
function makeDeployment(t, { config, cli }) {
  const base = mkdtempSync(join(tmpdir(), 'cas-notes-deploy-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dev = join(base, 'dev');
  const dist = join(dev, 'packages', 'care-album-saver', 'dist');
  mkdirSync(join(dev, 'scripts'), { recursive: true });
  mkdirSync(dist, { recursive: true });
  copyFileSync(join(ROOT, 'scripts', 'deploy.js'), join(dev, 'scripts', 'deploy.js'));
  writeFileSync(join(dev, 'package.json'), '{ "name": "stand-in", "type": "module" }\n');
  writeFileSync(join(dist, 'config.js'), config);
  writeFileSync(join(dist, 'cli.js'), cli);
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=stand-in', '-c', 'user.email=stand-in@example.invalid', ...args], { cwd: dev, env: gitEnv(), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'stand-in');

  const bin = join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'pnpm'), 0o755);
  // npm, as deploy.js uses it: `prefix --global` names a folder inside the throwaway one, and
  // `install` links the package's command into its bin, or fails as npm does when the file
  // npm-fails exists. Every call is written to npm.log.
  const prefix = join(base, 'npm-prefix');
  writeFileSync(join(bin, 'npm'), [
    '#!/bin/sh',
    `echo "$*" >> '${join(base, 'npm.log')}'`,
    'case "$1" in',
    `  prefix) echo '${prefix}' ;;`,
    '  install)',
    `    if [ -f '${join(base, 'npm-fails')}' ]; then echo "npm error code EACCES" >&2; echo "npm error syscall symlink" >&2; exit 1; fi`,
    '    for last; do :; done',
    `    mkdir -p '${join(prefix, 'bin')}' && ln -sfn "$last/dist/cli.js" '${join(prefix, 'bin', 'care-album-saver')}' ;;`,
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'npm'), 0o755);
  return { base, dev, prod: join(base, 'prod'), bin, prefix };
}

/** What the stand-in npm was asked, one call a line. */
const npmCalls = ({ base }) => (existsSync(join(base, 'npm.log')) ? readFileSync(join(base, 'npm.log'), 'utf8').trim().split('\n') : []);

function deploy({ dev, prod, bin }, { link = false } = {}) {
  const env = { ...gitEnv(), PATH: `${bin}${delimiter}${process.env.PATH}` };
  if (link) delete env.CARE_ALBUM_NO_GLOBAL_LINK;
  const r = spawnSync(process.execPath, [join(dev, 'scripts', 'deploy.js'), '--to', prod], { cwd: dev, env, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

const SCHEDULED = 'export async function loadConfig() { return { schedule: { time: "07:30" } }; }\n';

test('when `schedule on` fails, deploy.js says production was deployed and the daily run was not moved (sc-8)', posixOnly, (t) => {
  const d = makeDeployment(t, {
    config: SCHEDULED,
    cli: 'process.stdout.write("  Not set up: a stand-in scheduler said no.\\n");\nprocess.stderr.write("stand-in stderr\\n");\nprocess.exit(3);\n',
  });
  const r = deploy(d);
  assert.equal(r.status, 1, r.out + r.err);
  assert.match(r.err, /Deployed, but not finished: [0-9a-f]{7} is in production, but the daily run was not moved there: `schedule on --at 07:30` failed/);
  assert.doesNotMatch(r.err, /Not deployed/, 'production was updated, so the message must not say it was not');
  assert.match(r.err, /To try again: node ".*cli\.js" schedule on --at 07:30 --replace/);
  assert.match(r.err, /Not set up: a stand-in scheduler said no\./, 'with what the tool printed');
  assert.doesNotMatch(r.err, /\bat (?:checkExecSyncError|execFileSync|file:\/\/)/, 'not a stack trace');
  // It got that far: production is on main and marked, and so is the development checkout.
  assert.ok(existsSync(join(d.prod, '.care-album-saver-production')));
  assert.ok(existsSync(join(d.dev, '.git', 'care-album-saver-development')));
});

test('when the saved settings cannot be read, it says so in the same words', posixOnly, (t) => {
  const d = makeDeployment(t, {
    config: 'export async function loadConfig() { throw new Error("stand-in: the settings are damaged"); }\n',
    cli: 'process.exit(0);\n',
  });
  const r = deploy(d);
  assert.equal(r.status, 1, r.out + r.err);
  assert.match(r.err, /Deployed, but not finished: [0-9a-f]{7} is in production, but the daily run was not moved there: its settings could not be read\./);
  assert.doesNotMatch(r.err, /Not deployed/, 'production was updated, so the message must not say it was not');
  assert.match(r.err, /stand-in: the settings are damaged/);
});

test('and when it works, it says the run moved and that it deployed', posixOnly, (t) => {
  const d = makeDeployment(t, { config: SCHEDULED, cli: 'process.stdout.write("  Daily run: 07:30 (stand-in)\\n");\n' });
  const r = deploy(d);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /Moving the daily run \(07:30\) to production…\n\s+Daily run: 07:30 \(stand-in\)/);
  assert.match(r.out, /Deployed [0-9a-f]{7} to production\./);
  assert.match(readFileSync(join(d.prod, '.care-album-saver-production'), 'utf8'), /^\/.*\nproduction, deployed /);
});

// The command (2026-10-01). `care-album-saver` on the PATH runs production, linked by npm.

const UNSCHEDULED = 'export async function loadConfig() { return {}; }\n';

test('under test, deploy.js leaves the care-album-saver command alone and never starts npm', posixOnly, (t) => {
  const d = makeDeployment(t, { config: UNSCHEDULED, cli: 'process.exit(0);\n' });
  const r = deploy(d);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /The care-album-saver command was left as it is \(CARE_ALBUM_NO_GLOBAL_LINK is set\)\./);
  assert.deepEqual(npmCalls(d), [], 'not even to ask where its commands go');
  assert.match(r.out, /Deployed [0-9a-f]{7} to production\./);
});

test('it links the command to production, and a second deploy leaves a command that already runs production alone', posixOnly, (t) => {
  const d = makeDeployment(t, { config: UNSCHEDULED, cli: 'process.exit(0);\n' });
  const pkg = join(d.prod, 'packages', 'care-album-saver');
  const first = deploy(d, { link: true });
  assert.equal(first.status, 0, first.out + first.err);
  assert.deepEqual(npmCalls(d), ['prefix --global', `install --global --ignore-scripts --no-audit --no-fund ${pkg}`],
    'production\'s package folder, never the development checkout');
  assert.match(first.out, /Linking the care-album-saver command to production…/);
  assert.match(first.out, /care-album-saver now runs production, from any folder \(.*npm-prefix\/bin\/care-album-saver\)\./);
  assert.equal(realpathSync(join(d.prefix, 'bin', 'care-album-saver')), realpathSync(join(pkg, 'dist', 'cli.js')));

  const second = deploy(d, { link: true });
  assert.equal(second.status, 0, second.out + second.err);
  assert.match(second.out, /The care-album-saver command already runs production\./);
  assert.deepEqual(npmCalls(d).slice(2), ['prefix --global'], 'asked where, and nothing installed');
});

test('a command that ran something else is relinked, and deploy.js says what it ran', posixOnly, (t) => {
  const d = makeDeployment(t, { config: UNSCHEDULED, cli: 'process.exit(0);\n' });
  const elsewhere = join(d.base, 'elsewhere-cli.js');
  writeFileSync(elsewhere, 'process.exit(0);\n');
  mkdirSync(join(d.prefix, 'bin'), { recursive: true });
  symlinkSync(elsewhere, join(d.prefix, 'bin', 'care-album-saver'));
  const r = deploy(d, { link: true });
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /Linking the care-album-saver command to production \(it ran .*elsewhere-cli\.js\)…/);
  assert.equal(npmCalls(d).length, 2);
});

test('when npm cannot link it, deploy.js says production was deployed and how to link it by hand', posixOnly, (t) => {
  const d = makeDeployment(t, { config: UNSCHEDULED, cli: 'process.exit(0);\n' });
  writeFileSync(join(d.base, 'npm-fails'), '');
  const r = deploy(d, { link: true });
  assert.equal(r.status, 1, r.out + r.err);
  assert.match(r.err, /Deployed, but not finished: [0-9a-f]{7} is in production, but the care-album-saver command was not linked to it: npm said "code EACCES"\./);
  assert.match(r.err, /To try again: npm install -g ".*prod\/packages\/care-album-saver"/);
  assert.doesNotMatch(r.err, /Not deployed|\bat (?:checkExecSyncError|execFileSync|file:\/\/)/);
  assert.ok(existsSync(join(d.prod, '.care-album-saver-production')), 'production was deployed and marked');
});
