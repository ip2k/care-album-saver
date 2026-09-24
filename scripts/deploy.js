#!/usr/bin/env node
/**
 * Put `main` into production: the copy of the tool that runs the real daily job and the
 * real setup page, kept apart from the development checkout.
 *
 *     node scripts/deploy.js [--to <folder>] [--dry-run]
 *
 * Production is its own clone, by default ~/Applications/care-album-saver, on `main` and
 * nothing else. This script:
 *
 *   1. makes that clone if it is missing, from this repository;
 *   2. fast-forwards it to this repository's `main` — and refuses if production has changes
 *      of its own or has drifted onto another branch, rather than guessing;
 *   3. installs dependencies from the lockfile, builds, and runs the whole test suite there —
 *      and if any of that fails, puts production back on the commit it was on and rebuilds
 *      it, because the daily run runs production's dist/ and the build has already replaced
 *      it by the time the tests run;
 *   4. marks the clone as production (an untracked .care-album-saver-production file), and
 *      this checkout as development (a file inside its .git, shared by its worktrees);
 *   5. and, when a daily run is set up, reinstalls it from production at the same time of
 *      day, so the scheduled job runs production's code and never a development build.
 *
 * Why this exists: the daily run used to point at the development checkout's dist/, so every
 * build of a branch in progress went live at the next scheduled run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DEV = resolve(fileURLToPath(new URL('..', import.meta.url)));
const { values } = parseArgs({
  options: { to: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
});
const PROD = resolve(values.to ?? join(homedir(), 'Applications', 'care-album-saver'));
const MARKER = '.care-album-saver-production';
const DEVELOPMENT_MARKER = 'care-album-saver-development';
const dry = values['dry-run'];

const say = (line) => process.stdout.write(`  ${line}\n`);
const run = (cmd, args, cwd, opts = {}) => {
  if (dry && opts.mutates) {
    say(`(dry run) would run: ${cmd} ${args.join(' ')}  in ${cwd}`);
    return '';
  }
  return execFileSync(cmd, args, {
    cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
  }).trim();
};
const fail = (why) => {
  process.stderr.write(`\n  Not deployed: ${why}\n`);
  process.exit(1);
};

if (PROD === DEV || PROD.startsWith(DEV + '/')) fail('production must be a separate folder from this checkout.');

const devMain = run('git', ['rev-parse', 'main'], DEV, { quiet: true });
say(`Development checkout: ${DEV}`);
say(`Production:           ${PROD}`);
say(`main is at ${devMain.slice(0, 7)}`);

// 1. The clone.
if (!existsSync(join(PROD, '.git'))) {
  mkdirSync(dirname(PROD), { recursive: true });
  run('git', ['clone', '--branch', 'main', '--single-branch', DEV, PROD], dirname(PROD), { mutates: true });
}

if (!dry || existsSync(join(PROD, '.git'))) {
  // 2. Fast-forward only, and only a clean `main`.
  const branch = run('git', ['branch', '--show-current'], PROD, { quiet: true });
  if (branch !== 'main') fail(`production is on "${branch}", not main. Put it back on main by hand first.`);
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=no'], PROD, { quiet: true });
  if (dirty) fail('production has changes of its own. Nothing is changed in production except by this script.');
  // Where production was, to put it back to if this deploy fails. A clone without the mark
  // has never been deployed, so no daily run points at it and there is nothing to put back.
  const before = run('git', ['rev-parse', 'HEAD'], PROD, { quiet: true });
  const firstDeploy = !existsSync(join(PROD, MARKER));
  run('git', ['fetch', DEV, 'main'], PROD, { mutates: true });
  run('git', ['merge', '--ff-only', 'FETCH_HEAD'], PROD, { mutates: true });
  const prodAt = dry ? devMain : run('git', ['rev-parse', 'HEAD'], PROD, { quiet: true });
  if (!dry && prodAt !== devMain) fail(`production is at ${prodAt.slice(0, 7)} after the update, not ${devMain.slice(0, 7)}.`);

  // 3. Build and test in production itself: what runs is what was tested. The build replaces
  // the dist/ the daily run uses before the tests can say whether it should have, so a
  // failure from here on puts the previous commit back and rebuilds it.
  let step = 'installing';
  try {
    run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], PROD, { mutates: true });
    step = 'building';
    run('pnpm', ['run', 'build'], PROD, { mutates: true });
    step = 'testing';
    say('Running the test suite in production…');
    // The suite makes its own throwaway folders (scripts/test-env.js) unless it inherits
    // some. Folders set in the shell that runs this — a demo's, or a test's — would be shared
    // by every deploy's run of the suite, and each would find the last one's settings.
    const testEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CARE_ALBUM_|BRIGHTWHEEL_)/.test(k)));
    run('pnpm', ['test'], PROD, { mutates: true, quiet: true, env: testEnv });
  } catch (error) {
    const out = String(error.stdout ?? '').split('\n').filter((l) => /^(ℹ (tests|pass|fail)|✖)/.test(l)).slice(0, 12).join('\n  ');
    const what = step === 'testing' ? 'the tests failed in production' : `${step} failed in production`;
    if (firstDeploy) fail(`${what}. The daily run was not moved here, so it is running what it ran before.\n  ${out}`);
    if (before === devMain) fail(`${what}. Production was already on ${before.slice(0, 7)}, so this changed nothing it runs.\n  ${out}`);
    try {
      run('git', ['reset', '--hard', before], PROD, { mutates: true, quiet: true });
      run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], PROD, { mutates: true, quiet: true });
      run('pnpm', ['exec', 'tsc', '--build', '--clean'], PROD, { mutates: true, quiet: true });
      run('pnpm', ['run', 'build'], PROD, { mutates: true, quiet: true });
    } catch (rollback) {
      fail(`${what}, and putting production back on ${before.slice(0, 7)} failed too: ${rollback.message}\n` +
        `  The daily run will run whatever is in ${PROD}/packages/care-album-saver/dist until this is fixed.\n  ${out}`);
    }
    fail(`${what}, so production was put back on ${before.slice(0, 7)} and rebuilt; the daily run is running what it ran before.\n  ${out}`);
  }

  // 4. The marks the tool looks for: this clone is production, and the checkout it was
  // deployed from is development — marked inside git's own folder, which is never committed
  // and which every worktree of the checkout shares. Nothing else marks a copy development,
  // so a parent's clone of the repository is simply an installed copy.
  if (!dry) {
    writeFileSync(join(PROD, MARKER), `production, deployed ${new Date().toISOString()} at ${devMain}\n`);
    const common = resolve(DEV, run('git', ['rev-parse', '--git-common-dir'], DEV, { quiet: true }));
    writeFileSync(join(common, DEVELOPMENT_MARKER), `development: deploys to ${PROD}\n`);
  }

  // 5. The daily run, reinstalled from production at the same time of day.
  const cli = join(PROD, 'packages', 'care-album-saver', 'dist', 'cli.js');
  const time = dry && !existsSync(cli) ? null : readScheduledTime();
  if (time) {
    say(`Moving the daily run (${time}) to production…`);
    say(run(process.execPath, [cli, 'schedule', 'on', '--at', time], PROD, { mutates: true }).split('\n').join('\n  '));
  } else {
    say('No daily run is set up, so there is nothing to move.');
  }
  say(dry ? 'Dry run finished; nothing was changed.' : `Deployed ${devMain.slice(0, 7)} to production.`);
}

/** The daily run's time from the saved settings, read the way the tool reads them. */
function readScheduledTime() {
  const out = run(process.execPath, ['--input-type=module', '-e',
    `const { loadConfig } = await import(${JSON.stringify(join(PROD, 'packages', 'care-album-saver', 'dist', 'config.js'))});` +
    ` const c = await loadConfig(); process.stdout.write(c.schedule?.time ?? '');`], PROD, { quiet: true });
  return /^\d{2}:\d{2}$/.test(out) ? out : null;
}
