#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { stdin, stdout } from 'node:process';
import { BrightwheelClient } from './api/client.js';
import {
  checkBaseUrl,
  ConfigUnusableError,
  DEFAULT_CONFIG,
  loadConfig,
  loadSession,
  refuseLiveApiUnderTest,
  saveConfig,
  saveSession,
  SessionUnusableError,
} from './config.js';
import { configDir, legacyConfigDir, configPath, sessionPath } from './paths.js';
import { Secret, scrub } from './secrets.js';
import { inspectCookiePaste } from './paste.js';
import { sync } from './sync.js';
import { startWebUi } from './web/server.js';
import { formatReport, verify } from './verify.js';
import { archiveBusy, auditArchive, checkChildren, findDuplicates, removeDuplicates, repairManifest } from './maintenance.js';
import * as schedule from './schedule.js';
import { DEVELOPMENT_SCHEDULE_REFUSAL, environment } from './environment.js';
import { stampLines } from './log-lines.js';
import { addToPhotos, photosStatus, photosSupported, PHOTOS_FOLDER } from './photos.js';
import type { Config } from './config.js';

const HELP = `
care-album-saver — save your own child's photos from Brightwheel

Setting it up, once
  care-album-saver setup        Open the setup assistant in your browser (easiest)
  care-album-saver login        Paste your Brightwheel session in the terminal

Every day after that
  care-album-saver schedule     Show whether photos are being saved automatically
    on --at 19:00                  Save new photos every day at that time
    off                            Stop saving them automatically
    --replace                      ...even when another copy of this tool set it up
  care-album-saver run          Save any new photos now (Ctrl+C stops after the current one)

Looking after the archive
  care-album-saver children     List the children on your account, with their ids
  care-album-saver recheck      Ask Brightwheel who is on the account now
  care-album-saver check        Compare the folder with the tool's own list of it
    --repair                       ...and fix the list, without downloading anything
  care-album-saver duplicates   Find photos saved twice (shows them; deletes nothing)
    --remove                       ...and offer to delete the extra copies
  care-album-saver doctor       Check that everything is working
  care-album-saver verify       Check the Brightwheel API shape (read-only, no photos)
    --deep                         ...and read three photos to see whether they carry their own capture time
  care-album-saver where        Show where files are kept

Options
  --dir <path>       Where to save photos (default: ~/Care Album Photos)
  --all              Re-check every photo, not just new ones
  --no-name-tag      Do not write any name into the photo metadata
  --child <id|name>  Only this child, for this run (repeat for several; your saved
                     settings are not changed)
  --at <HH:MM>       Time of day for the daily run (24-hour clock)
  --port <number>    Port for the setup assistant
  --base-url <url>   Talk to this API instead of Brightwheel's (the tests' mock). Your
                     saved session is sent to it, so it must be https, or http to
                     this computer itself
  --help             Show this message

Your session is stored in your user config folder, never in this project folder:
  ${configDir()}
`;

/**
 * Whether the run's own progress stream has already told the parent that it failed.
 *
 * `sync` reports a mid-run failure as a progress event *and* throws it, so without this the
 * same sentence was printed twice: once as a progress line, once by the catch below.
 */
let failureAnnounced = false;

/**
 * After a run: hand its new photos to the Photos app, if the parent turned that on.
 *
 * Runs after a failed run as well as a finished one — what was saved before the failure is
 * on disk and just as new — but never after Ctrl+C, which means stop. Its own failure never
 * fails the run: the photos are safe in the folder either way, and are added next time.
 */
/**
 * A scheduled run fails at seven in the evening with nobody watching. Unless the failure is
 * written down, the tool has no way to answer "is this still working?" — and an expired
 * session looks exactly like an archive that is up to date. So it goes in the log and the
 * last-run record, and a notice says so where somebody will see it: the record answers the
 * question, the notice is what makes anyone ask it. Fixed text — the error is not in it —
 * and a desktop with no notifier just means the record is the only trace.
 */
async function recordScheduledFailure(error: unknown): Promise<void> {
  const message = scrub(error instanceof Error ? error.message : String(error));
  await schedule.appendLog(`FAILED  ${message}`);
  await schedule.recordRun({ at: new Date().toISOString(), ok: false, saved: 0, failed: 0, message, trigger: 'schedule' });
  await schedule.notify('failed').catch(() => false);
}

async function photosStep(config: Config, scheduled: boolean): Promise<void> {
  if (!config.addToPhotos || !photosSupported()) return;
  const before = await photosStatus(config).catch(() => null);
  const outcome = await addToPhotos(config, { onProgress: (m) => stdout.write(`  ${m}\n`) }).catch((error: unknown) => ({
    ok: false,
    added: 0,
    reason: 'failed' as const,
    error: error instanceof Error ? error.message : String(error),
  }));
  if (outcome.ok) {
    if (outcome.added > 0) stdout.write(`  Added ${outcome.added} to Photos, in the ${PHOTOS_FOLDER} folder.\n`);
  } else {
    stdout.write(`  Not added to Photos: ${scrub(outcome.error ?? 'no reason given')}\n`);
  }
  if (!scheduled) return;
  // The Photos record can be read again, so it is what remembers the last attempt once more:
  // a damaged record's notice, below, has been dealt with.
  if (before && !before.problem) await schedule.forgetNotice('photos').catch(() => {});
  if (outcome.ok && outcome.added === 0) return;
  await schedule.appendLog(
    `PHOTOS  ` +
      (outcome.ok ? `added ${outcome.added} to Photos` : `not added: ${scrub(outcome.error ?? 'no reason given')}`),
  );
  if (outcome.ok || outcome.reason === 'busy') return;
  // Said once, when it starts failing: a permission that was never granted would otherwise
  // fail quietly every evening while the page is the only place that knows. The Photos record
  // is what says the last attempt already failed — and while that record is itself damaged it
  // says nothing, so the notice came back every evening (security review §4.4). Then the
  // problem is remembered beside it instead, and said once for each different one.
  if (before?.problem) {
    await schedule.announceOnce('photos', before.problem).catch(() => false);
  } else if (before?.lastAttempt?.ok !== false) {
    await schedule.notify('photos').catch(() => false);
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      all: { type: 'boolean' },
      'no-name-tag': { type: 'boolean' },
      child: { type: 'string', multiple: true },
      port: { type: 'string' },
      'from-dev': { type: 'boolean', default: false },
      // Take over, or turn off, a daily run another copy of the tool set up. See
      // ScheduleOwnedElsewhereError in schedule.ts.
      replace: { type: 'boolean', default: false },
      'base-url': { type: 'string' },
      deep: { type: 'boolean' },
      at: { type: 'string' },
      repair: { type: 'boolean' },
      remove: { type: 'boolean' },
      // Set by the job the scheduler runs, never by a person. It is what tells the run to
      // write down how it went, so that a session which expired three weeks ago does not
      // look exactly like one that is fine.
      scheduled: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const command = positionals[0] ?? 'setup';
  if (values.help || command === 'help') {
    stdout.write(HELP);
    return 0;
  }

  const baseUrl = values['base-url'];
  // Refused before anything is read, let alone sent (security review outbound-13).
  if (baseUrl !== undefined) {
    try {
      checkBaseUrl(baseUrl);
    } catch (error) {
      stdout.write(`  ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  /**
   * The API to hand a client: --base-url, or Brightwheel's own — except in a test, which
   * must name one (scripts/test-env.js; the review's docs-14). Asked where a client is made,
   * so that the commands a test runs without touching the API are unaffected.
   */
  const api = (): string | undefined => {
    refuseLiveApiUnderTest(baseUrl);
    return baseUrl;
  };
  let config: Config;
  // Why the settings could not be read, for the three commands that still run without them.
  let configProblem: string | null = null;
  try {
    config = await loadConfig();
    // The daily run exists only because settings were saved with it in them, so a scheduled
    // run that finds none has not found a first run: the file was moved or deleted, perhaps on
    // the advice of the refusal below. Starting from the defaults would begin a second
    // archive of every child in the default folder — the thing ConfigUnusableError prevents.
    if (values.scheduled && !existsSync(configPath())) {
      throw new Error(
        `The daily run found no settings (${configPath()} is not there), so it has saved nothing. ` +
          'Open the setup assistant to set the tool up again.',
      );
    }
  } catch (error) {
    // The daily run's refusal is recorded like any failure of it, or it would stop in silence,
    // and it is not printed as well: under the scheduler, what is printed is the log.
    if (values.scheduled) {
      await recordScheduledFailure(error);
      failureAnnounced = true;
      throw error;
    }
    // Damaged settings stop every command that would act on them — see ConfigUnusableError —
    // but not the ones that help sort it out: the setup assistant, which shows the problem at
    // the top of the page (and is where the "did not work" notice sends people), `where` and
    // `doctor` — and `schedule`, whose `off` is the first thing to do about damaged settings
    // (it re-reads them itself; `on` still refuses). None of them saves the defaults standing in here.
    if (!(error instanceof ConfigUnusableError) || !['setup', 'where', 'doctor', 'schedule'].includes(command)) throw error;
    configProblem = error.message;
    config = { ...DEFAULT_CONFIG };
  }
  // What the command line says about the settings, kept apart so that `login`, which saves
  // them, can save these and nothing else (see there).
  const overrides: Partial<Config> = {};
  if (values.dir) overrides.archiveDir = values.dir;
  if (values.all) overrides.incremental = false;
  if (values['no-name-tag']) overrides.tagChildName = false;
  Object.assign(config, overrides);

  switch (command) {
    case 'where': {
      stdout.write(
        `Photos:   ${configProblem ? '(unknown until the settings can be read)' : config.archiveDir}\n` +
          `Settings: ${configPath()}\nSession:  ${sessionPath()}\nLast run: ${schedule.lastRunPath()}\n`,
      );
      if (configProblem) stdout.write(`\n  ${scrub(configProblem)}\n`);
      return 0;
    }

    case 'schedule': {
      const what = positionals[1];
      if (what === 'on') {
        if (environment() === 'development' && !values['from-dev']) {
          stdout.write(`  ${DEVELOPMENT_SCHEDULE_REFUSAL}\n  (To use this copy anyway, add --from-dev.)\n`);
          return 1;
        }
        // The default is the evening: the nursery day is over, the photos for the day are
        // posted, and the computer is more likely to be on than at three in the morning.
        const owned = { replace: values.replace, replaceProduction: values.replace };
        try {
          const result = await schedule.install(values.at ?? '19:00', {}, owned);
          stdout.write(`\n  ${result.summary}\n  It is written down in: ${result.location}\n\n`);
          return 0;
        } catch (error) {
          if (!(error instanceof schedule.ScheduleOwnedElsewhereError)) throw error;
          stdout.write(`  ${error.message}\n  (To have this copy take it over anyway, add --replace.)\n`);
          return 1;
        }
      }
      if (what === 'off') {
        try {
          const result = await schedule.remove({}, { replace: values.replace, replaceProduction: values.replace });
          stdout.write(`\n  ${result.summary}\n\n`);
          return 0;
        } catch (error) {
          if (!(error instanceof schedule.ScheduleOwnedElsewhereError)) throw error;
          stdout.write(`  ${error.message}\n  (To turn it off from this copy anyway, add --replace.)\n`);
          return 1;
        }
      }
      if (what !== undefined) {
        stdout.write(`  Unknown option "${what}". Use: care-album-saver schedule [on --at HH:MM | off]\n`);
        return 1;
      }
      const state = await schedule.status();
      stdout.write(`\n  ${state.summary}\n`);
      if (state.installed) {
        stdout.write(`  Next run:  ${state.nextRun ? new Date(state.nextRun).toLocaleString() : 'unknown'}\n`);
        stdout.write(`  Set up in: ${state.location}\n`);
      }
      if (state.lastRun) {
        const last = state.lastRun;
        stdout.write(
          `  Last run:  ${new Date(last.at).toLocaleString()} — ${last.ok ? 'worked' : 'did not work'}. ${scrub(last.message)}\n`,
        );
      } else {
        stdout.write('  Last run:  it has not run on its own yet.\n');
      }
      stdout.write('\n');
      return 0;
    }

    case 'recheck': {
      const session = await loadSession();
      if (!session) {
        stdout.write('  Not signed in. Run: care-album-saver login\n');
        return 1;
      }
      const client = new BrightwheelClient({ session: session.session, baseUrl: api(), userAgent: session.userAgent });
      const check = await checkChildren(client, config);
      stdout.write(`\n  ${check.summary}\n`);
      if (check.notIncluded.length > 0) {
        // By id, not by name (security review processes-8). The names come from Brightwheel,
        // and inside double quotes a `$(…)` or a backtick in one runs when the command is
        // pasted into a shell. An id is Brightwheel's too, so it is quoted when it is anything
        // but letters, digits and . _ - — which every id seen so far is.
        stdout.write(
          `\n  To include everyone, open the setup assistant, or run with --child for a one-off\n` +
            `  (care-album-saver children lists each child with their id):\n` +
            `    care-album-saver run ${check.notIncluded.map((c) => `--child ${shellArgument(c.id)}`).join(' ')}\n`,
        );
      }
      stdout.write('\n');
      return 0;
    }

    case 'check': {
      // While a run — the daily one, say — is writing the list, what the list says is half
      // written and a repair would be refused, so that is said instead (security review web-5).
      const busy = await archiveBusy(config, values.repair ? 'repair' : 'check');
      if (busy) {
        stdout.write(`\n  ${busy}\n\n`);
        return 1;
      }
      const audit = await auditArchive(config);
      stdout.write(`\n  ${audit.archiveDir}\n  ${audit.summary}\n`);
      for (const file of audit.unrecorded.slice(0, 10)) stdout.write(`    not on the list: ${file}\n`);
      for (const file of audit.missing.slice(0, 10)) stdout.write(`    listed but gone: ${file}\n`);
      if (!values.repair) {
        if (audit.repairable) stdout.write('\n  Nothing has been changed. Run again with --repair to fix the list.\n');
        stdout.write('\n');
        return 0;
      }
      const repair = await repairManifest(config);
      stdout.write(`\n  ${repair.summary}\n\n`);
      return 0;
    }

    case 'duplicates': {
      // Before the question, not after it: a parent should not type "yes" to a deletion the
      // run lock is about to refuse (security review web-5). removeDuplicates takes the lock
      // itself, so a run that starts while the question is on screen is still kept out.
      const busy = await archiveBusy(config, values.remove ? 'duplicates' : 'check');
      if (busy) {
        stdout.write(`\n  ${busy}\n\n`);
        return 1;
      }
      const report = await findDuplicates(config);
      stdout.write(`\n  ${report.summary}\n`);
      for (const group of report.groups) {
        stdout.write(`\n    keeping: ${group.keep}\n`);
        for (const extra of group.extra) stdout.write(`    copy of it: ${extra}\n`);
      }
      if (report.files === 0 || !values.remove) {
        if (report.files > 0) stdout.write('\n  Nothing has been deleted. Run again with --remove to delete the copies.\n');
        stdout.write('\n');
        return 0;
      }
      // Shown in full above, and then asked about. A photograph of a child is not deleted
      // on the strength of a flag alone.
      const rl = createInterface({ input: stdin, output: stdout });
      const answer = await rl.question(
        `\n  Delete ${report.files === 1 ? 'that extra copy' : `those ${report.files} extra copies`}? Type yes to confirm: `,
      );
      rl.close();
      if (answer.trim().toLowerCase() !== 'yes') {
        stdout.write('\n  Nothing was deleted.\n\n');
        return 0;
      }
      const result = await removeDuplicates(config, {
        confirm: report.groups.flatMap((g) => g.extra),
      });
      stdout.write(`\n  ${result.summary}\n\n`);
      return 0;
    }

    case 'setup': {
      // A development copy says so across the top of the page when it is pointed at real
      // settings and photos, so it is never mistaken for production.
      const banner =
        environment() === 'development' && !baseUrl
          ? 'Development copy — this page is using your real settings, session and photos. Production is the copy scripts/deploy.js installs.'
          : undefined;
      const ui = await startWebUi({ port: values.port ? Number(values.port) : 0, baseUrl: api(), banner });
      stdout.write(
        `\n  Setup assistant is ready.\n\n  Open this link in your browser:\n\n    ${ui.url}\n\n` +
          `  This page is only reachable from this computer.\n  Press Ctrl+C when you are finished.\n\n`,
      );
      // Ctrl+C closes the assistant, and closing it stops a run that is in progress —
      // which waits for the photo being saved, so it is not instant. A parent who does not
      // want to wait presses Ctrl+C again and that is the end of it.
      await new Promise<void>((resolve) => {
        let closing = false;
        process.on('SIGINT', () => {
          if (closing) process.exit(130);
          closing = true;
          stdout.write('\n  Closing the setup assistant…\n');
          resolve();
        });
      });
      await ui.close();
      return 0;
    }

    case 'login': {
      // The pasted value is never echoed. A session in terminal scrollback is the exact
      // thing the Secret class exists to keep out of a screenshot or a pasted log, and
      // asking for one in a prompt that prints it back undoes that in the first second of
      // using the tool. The prompt itself still prints; only what is typed is swallowed,
      // which is the idiom every password prompt on Node uses.
      let muted = false;
      const output = new Writable({
        write(chunk, _encoding, done) {
          if (!muted) stdout.write(chunk);
          done();
        },
      });
      const rl = createInterface({ input: stdin, output, terminal: true });
      stdout.write(
        `\n  Sign in at https://schools.mybrightwheel.com in your browser.\n` +
          `  Then open developer tools (F12) — Application or Storage, then Cookies —\n` +
          `  and copy the value of the cookie named _brightwheel_v2.\n` +
          `  There are pictures of these steps in docs/COOKIE.md.\n\n`,
      );
      const question = rl.question('  Paste it here (it will not be shown): ');
      muted = true;
      const pasted = await question;
      muted = false;
      rl.close();
      stdout.write('\n');
      const verdict = inspectCookiePaste(pasted);
      if (!verdict.ok) {
        stdout.write(`\n  ${verdict.message} Nothing was saved.\n`);
        return 1;
      }
      for (const note of verdict.notes) stdout.write(`  (${note})\n`);
      if (verdict.level === 'warn') stdout.write(`  ${verdict.message}\n`);
      const secret = new Secret(verdict.value);
      const client = new BrightwheelClient({ session: secret, baseUrl: api() });
      const check = await client.verifySession();
      if (!check.ok) {
        stdout.write(`\n  Could not sign in: ${scrub(check.reason)}\n`);
        return 1;
      }
      await saveSession(secret, check.email);
      // Read again now, not the copy loaded before the prompt, and changed only where the
      // command line said to (the review's §4.4, "login race"). The paste can take minutes,
      // and writing back the settings as they were then undid whatever changed meanwhile —
      // the daily run turned on or moved from the setup page, a folder chosen there.
      await saveConfig({ ...(await loadConfig()), ...overrides });
      stdout.write(`\n  Signed in${check.email ? ` as ${check.email}` : ''}. Now run: care-album-saver run\n`);
      return 0;
    }

    case 'children': {
      const session = await loadSession();
      if (!session) {
        stdout.write('  Not signed in. Run: care-album-saver login\n');
        return 1;
      }
      const client = new BrightwheelClient({ session: session.session, baseUrl: api(), userAgent: session.userAgent });
      const me = await client.me();
      const children = await client.students(me.id);
      const width = Math.max(...children.map((c) => c.fullName.length));
      for (const child of children) {
        stdout.write(
          `  ${child.fullName.padEnd(width)}  id: ${child.id}${child.schoolName ? `  (${child.schoolName})` : ''}\n`,
        );
      }
      stdout.write(`\n  To save photos for some of them only: care-album-saver run --child <id or name>\n`);
      return 0;
    }

    case 'doctor': {
      let sessionProblem: string | null = null;
      const session = await loadSession().catch((error: unknown) => {
        if (!(error instanceof SessionUnusableError)) throw error;
        sessionProblem = error.message;
        return null;
      });
      stdout.write(`  Config folder: ${configDir()}\n`);
      // Say it plainly when the tool is still reading the folder it used before the
      // rename, rather than leaving someone to wonder why the new name is nowhere on disk.
      const legacy = legacyConfigDir();
      if (legacy && legacy === configDir()) {
        stdout.write(`                 (the folder this tool used when it was called brightwheel-archive; still read, nothing was moved)\n`);
      }
      if (configProblem) {
        stdout.write(`  Settings:      cannot be used — ${scrub(configProblem)}\n`);
      } else {
        stdout.write(`  Photos folder: ${config.archiveDir}\n`);
      }
      stdout.write(`  Session saved: ${session ? `yes (${session.session.fingerprint()})` : sessionProblem ? `damaged — ${scrub(sessionProblem)}` : 'no'}\n`);
      if (!session) return 1;
      // The shape and length only — enough to tell "wrong row" from "expired", never the value.
      const shape = inspectCookiePaste(session.session.expose());
      stdout.write(`  Session shape: ${shape.kind} (${session.session.length} characters)\n`);
      const client = new BrightwheelClient({ session: session.session, baseUrl: api(), userAgent: session.userAgent });
      const check = await client.verifySession();
      stdout.write(`  Session works: ${check.ok ? 'yes' : `no — ${scrub(check.reason)}`}\n`);
      let exif = 'no (dates are saved in .json files next to each photo)';
      try {
        await import('exiftool-vendored');
        exif = 'yes';
      } catch {
        /* optional */
      }
      stdout.write(`  ExifTool:      ${exif}\n`);
      if (photosSupported()) {
        const photos = await photosStatus(config);
        const last = photos.lastAttempt;
        stdout.write(
          `  Add to Photos: ${photos.enabled ? `on (${photos.pending} waiting)` : 'off'}` +
            (photos.problem
              ? ` — ${scrub(photos.problem)}`
              : last && !last.ok
                ? ` — last attempt failed: ${scrub(last.error ?? '')}`
                : '') +
            '\n',
        );
        if (photos.warning) stdout.write(`                 ${photos.warning}\n`);
      }
      return check.ok ? 0 : 1;
    }

    case 'verify': {
      const session = await loadSession();
      if (!session) {
        stdout.write('  Not signed in. Run: care-album-saver setup\n');
        return 1;
      }
      try {
        const report = await verify(session.session, { baseUrl: api(), deep: values.deep, userAgent: session.userAgent });
        stdout.write(formatReport(report));
        stdout.write('  This output is safe to share.\n\n');
        return report.sessionValid ? 0 : 1;
      } catch (error) {
        stdout.write(`\n  Verification failed: ${scrub(error instanceof Error ? error.message : String(error))}\n`);
        return 1;
      }
    }

    case 'run': {
      // A scheduled run's output is the daily log — launchd and cron write it straight into
      // the file — so from here on every line it prints starts with when. Not under systemd,
      // whose journal stamps each line itself; there a second stamp would only be noise.
      if (values.scheduled && !process.env.JOURNAL_STREAM) {
        stampLines(process.stdout);
        stampLines(process.stderr);
      }
      // A scheduled invocation may be a catch-up rather than the schedule itself: launchd
      // starts this at every login, cron at every boot, Task Scheduler whenever it notices
      // a start it missed. Each of those is how a run the machine was off for eventually
      // happens — and each would otherwise also fire on days when nothing was missed. So
      // the first thing a scheduled run does is ask whether its occurrence is already
      // covered, and if it is, it stops here having opened no session and sent no request.
      if (values.scheduled) {
        // First, whether or not there is anything to do: the log was just opened for this
        // run's output — by launchd at 0644, or on Linux by cron's shell at the login umask —
        // and it names a child (the review's log-dir mode).
        await schedule.secureLog();
        const due = schedule.isDue(config.schedule, await schedule.loadLastRun());
        if (!due) {
          stdout.write('  Already up to date for today; nothing to do.\n');
          return 0;
        }
        await schedule.appendLog(`START   scheduled run`);
      }
      const session = await loadSession().catch(async (error: unknown) => {
        if (values.scheduled && error instanceof SessionUnusableError) await recordScheduledFailure(error);
        throw error;
      });
      if (!session) {
        stdout.write('  Not signed in. Run: care-album-saver login\n');
        // A daily run with nothing to sign in with has failed like any other, and is recorded
        // as one: otherwise the page goes on showing the last run that worked.
        if (values.scheduled) {
          await recordScheduledFailure(new Error('Not connected to Brightwheel, so nothing was saved. Connect again in the setup assistant.'));
        }
        return 1;
      }
      const client = new BrightwheelClient({
        session: session.session,
        userAgent: session.userAgent,
        baseUrl: api(),
        delayMs: config.delayMs,
      });
      if (values.child?.length) {
        // A one-off filter, applied to the loaded config and never written back: this
        // command does not save settings, so the setup page's choice survives it.
        const me = await client.me();
        const children = await client.students(me.id);
        const chosen: string[] = [];
        for (const wanted of values.child) {
          const needle = wanted.trim().toLowerCase();
          const match = children.find((c) => c.id === wanted.trim() || c.fullName.toLowerCase() === needle);
          if (!match) {
            stdout.write(`  No child called "${wanted}" on this account. Run: care-album-saver children\n`);
            return 1;
          }
          if (!chosen.includes(match.id)) chosen.push(match.id);
        }
        config.includeStudents = chosen;
        stdout.write(`  Only: ${children.filter((c) => chosen.includes(c.id)).map((c) => c.fullName).join(', ')}\n`);
      }
      // A run limited to some children with --child has not brought the whole archive up to
      // date, so it is not recorded as the day's run.
      const coversTheDay = !values.child?.length;
      // Ctrl+C: finish the photo being saved, write the manifest, stop. Anything harsher
      // throws away the download in flight and, worse, the record of the ones before it.
      // A second Ctrl+C is a parent saying they meant it, and ends the process there.
      const stop = new AbortController();
      let stopping = false;
      const onInterrupt = () => {
        if (stopping) process.exit(130);
        stopping = true;
        stop.abort();
        stdout.write('\n  Stopping after the current photo…\n');
      };
      process.on('SIGINT', onInterrupt);
      // SIGTERM is how the scheduler says stop — turning the daily run off, changing its
      // time or reinstalling it. Node's default is to die on the spot, which lost the list of
      // everything saved since the last 25 and had the next run fetch those again as copies.
      process.on('SIGTERM', onInterrupt);

      let lastLine = '';
      let result;
      try {
        result = await sync(
          client,
          config,
          (p) => {
            const line = `  ${scrub(p.message)}`;
            // Set before the repeat-suppression below: a failure whose text happens to
            // match the line already on screen is still a failure that has been said.
            if (p.phase === 'error') failureAnnounced = true;
            if (line === lastLine) return;
            stdout.write(`${line}\n`);
            lastLine = line;
          },
          { signal: stop.signal },
        );
      } catch (error) {
        // Another run holds the folder. Not a failure and not a record: that run is doing the
        // work, it records its own outcome, and it does the Photos step too. This one says so
        // and leaves, having read and fetched nothing.
        if (error instanceof Error && error.name === 'RunInProgressError') {
          stdout.write(`  ${error.message}\n`);
          if (values.scheduled) {
            // The refusal itself: it may be a repair or a duplicate removal holding the folder,
            // not another run, and on Linux and Windows this line is the only record of why.
            await schedule.appendLog(`SKIPPED ${error.message}`);
          }
          return 0;
        }
        if (values.scheduled) {
          await recordScheduledFailure(error);
        } else if (coversTheDay) {
          await schedule.recordRun({
            at: new Date().toISOString(),
            ok: false,
            saved: 0,
            failed: 0,
            message: scrub(error instanceof Error ? error.message : String(error)),
            trigger: 'manual',
          });
        }
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onInterrupt);
        if (!stop.signal.aborted) await photosStep(config, Boolean(values.scheduled)).catch(() => {});
        throw error;
      } finally {
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onInterrupt);
      }
      if (values.scheduled) {
        await schedule.recordRun(schedule.finishedRun(result, 'schedule'));
        await schedule.appendLog(
          `${result.failed === 0 && !result.stopped ? 'OK     ' : 'PARTIAL'}  ` +
            `${result.saved} saved, ${result.skipped} already had, ${result.failed} could not be fetched`,
        );
      }
      stdout.write(
        `\n  ${result.stopped ? 'Stopped' : 'Done'}. ${result.saved} new, ${result.skipped} already had, ` +
          `${result.failed} failed.\n  Photos are in: ${result.archiveDir}\n`,
      );
      // Recorded as well, so that the daily run's missed-run catch-up sees today is covered
      // and does not start the same work again at the next login.
      if (!values.scheduled && coversTheDay) await schedule.recordRun(schedule.finishedRun(result, 'manual'));
      if (result.stopped) stdout.write('  Run the same command again to carry on where it left off.\n');
      for (const w of result.warnings) stdout.write(`  Note: ${scrub(w)}\n`);
      if (!result.stopped) await photosStep(config, Boolean(values.scheduled));
      return result.failed > 0 ? 1 : 0;
    }

    default:
      stdout.write(`  Unknown command "${command}".\n${HELP}`);
      return 1;
  }
}

/**
 * One word for a POSIX shell, for a command this tool prints for a person to paste: as it is
 * when it holds nothing a shell reads specially, and otherwise in single quotes, inside which
 * nothing is special but the closing quote, written as '\''.
 */
function shellArgument(value: string): string {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // A failure the run already printed is not printed a second time: the same thing said
    // twice, in two shapes, reads as two separate things having gone wrong.
    if (failureAnnounced) process.exit(1);
    const message = error instanceof Error ? error.message : String(error);
    stdout.write(`\n  ${scrub(message)}\n`);
    process.exit(1);
  });
