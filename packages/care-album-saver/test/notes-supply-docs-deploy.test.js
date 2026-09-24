// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * production folder, with stand-ins for everything it starts: a `pnpm` that does nothing, and
 * a dist/ whose config.js and cli.js only say what the case needs. Nothing here reaches a
 * real scheduler, setting or checkout.
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
  return { base, dev, prod: join(base, 'prod'), bin };
}

function deploy({ dev, prod, bin }) {
  const env = { ...gitEnv(), PATH: `${bin}${delimiter}${process.env.PATH}` };
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
