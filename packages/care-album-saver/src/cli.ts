#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { stdin, stdout } from 'node:process';
import { BrightwheelClient } from './api/client.js';
import { loadConfig, loadSession, saveConfig, saveSession } from './config.js';
import { configDir, legacyConfigDir, configPath, sessionPath } from './paths.js';
import { Secret, scrub } from './secrets.js';
import { inspectCookiePaste } from './paste.js';
import { sync } from './sync.js';
import { startWebUi } from './web/server.js';
import { formatReport, verify } from './verify.js';
import { auditArchive, checkChildren, findDuplicates, removeDuplicates, repairManifest } from './maintenance.js';
import * as schedule from './schedule.js';
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
    --deep                         ...and read three photos to find the real capture time
  care-album-saver where        Show where files are kept

Options
  --dir <path>       Where to save photos (default: ~/Brightwheel Photos)
  --all              Re-check every photo, not just new ones
  --no-name-tag      Do not write any name into the photo metadata
  --child <id|name>  Only this child, for this run (repeat for several; your saved
                     settings are not changed)
  --at <HH:MM>       Time of day for the daily run (24-hour clock)
  --port <number>    Port for the setup assistant
  --base-url <url>   Point at a different API (used by the tests)
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
  if (outcome.ok && outcome.added === 0) return;
  await schedule.appendLog(
    `${new Date().toISOString()}  PHOTOS  ` +
      (outcome.ok ? `added ${outcome.added} to Photos` : `not added: ${scrub(outcome.error ?? 'no reason given')}`),
  );
  // Said once, when it starts failing: a permission that was never granted would otherwise
  // fail quietly every evening while the page is the only place that knows.
  if (!outcome.ok && outcome.reason !== 'busy' && before?.lastAttempt?.ok !== false) {
    await schedule.notify(schedule.PHOTOS_NOTICE).catch(() => false);
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
  const config = await loadConfig();
  if (values.dir) config.archiveDir = values.dir;
  if (values.all) config.incremental = false;
  if (values['no-name-tag']) config.tagChildName = false;

  switch (command) {
    case 'where': {
      stdout.write(
        `Photos:   ${config.archiveDir}\nSettings: ${configPath()}\nSession:  ${sessionPath()}\n` +
          `Last run: ${schedule.lastRunPath()}\n`,
      );
      return 0;
    }

    case 'schedule': {
      const what = positionals[1];
      if (what === 'on') {
        // The default is the evening: the nursery day is over, the photos for the day are
        // posted, and the computer is more likely to be on than at three in the morning.
        const result = await schedule.install(values.at ?? '19:00');
        stdout.write(`\n  ${result.summary}\n  It is written down in: ${result.location}\n\n`);
        return 0;
      }
      if (what === 'off') {
        const result = await schedule.remove();
        stdout.write(`\n  ${result.summary}\n\n`);
        return 0;
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
      const client = new BrightwheelClient({ session: session.session, baseUrl, userAgent: session.userAgent });
      const check = await checkChildren(client, config);
      stdout.write(`\n  ${check.summary}\n`);
      if (check.notIncluded.length > 0) {
        stdout.write(
          `\n  To include everyone, open the setup assistant, or run with --child for a one-off:\n` +
            `    care-album-saver run ${check.notIncluded.map((c) => `--child "${c.name}"`).join(' ')}\n`,
        );
      }
      stdout.write('\n');
      return 0;
    }

    case 'check': {
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
      const ui = await startWebUi({ port: values.port ? Number(values.port) : 0, baseUrl });
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
      const client = new BrightwheelClient({ session: secret, baseUrl });
      const check = await client.verifySession();
      if (!check.ok) {
        stdout.write(`\n  Could not sign in: ${scrub(check.reason)}\n`);
        return 1;
      }
      await saveSession(secret, check.email);
      await saveConfig(config);
      stdout.write(`\n  Signed in${check.email ? ` as ${check.email}` : ''}. Now run: care-album-saver run\n`);
      return 0;
    }

    case 'children': {
      const session = await loadSession();
      if (!session) {
        stdout.write('  Not signed in. Run: care-album-saver login\n');
        return 1;
      }
      const client = new BrightwheelClient({ session: session.session, baseUrl, userAgent: session.userAgent });
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
      const session = await loadSession();
      stdout.write(`  Config folder: ${configDir()}\n`);
      // Say it plainly when the tool is still reading the folder it used before the
      // rename, rather than leaving someone to wonder why the new name is nowhere on disk.
      const legacy = legacyConfigDir();
      if (legacy && legacy === configDir()) {
        stdout.write(`                 (the folder this tool used when it was called brightwheel-archive; still read, nothing was moved)\n`);
      }
      stdout.write(`  Photos folder: ${config.archiveDir}\n`);
      stdout.write(`  Session saved: ${session ? `yes (${session.session.fingerprint()})` : 'no'}\n`);
      if (!session) return 1;
      // The shape and length only — enough to tell "wrong row" from "expired", never the value.
      const shape = inspectCookiePaste(session.session.expose());
      stdout.write(`  Session shape: ${shape.kind} (${session.session.length} characters)\n`);
      const client = new BrightwheelClient({ session: session.session, baseUrl, userAgent: session.userAgent });
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
            (last && !last.ok ? ` — last attempt failed: ${scrub(last.error ?? '')}` : '') +
            '\n',
        );
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
        const report = await verify(session.session, { baseUrl, deep: values.deep, userAgent: session.userAgent });
        stdout.write(formatReport(report));
        stdout.write('  This output is safe to share.\n\n');
        return report.sessionValid ? 0 : 1;
      } catch (error) {
        stdout.write(`\n  Verification failed: ${scrub(error instanceof Error ? error.message : String(error))}\n`);
        return 1;
      }
    }

    case 'run': {
      // A scheduled invocation may be a catch-up rather than the schedule itself: launchd
      // starts this at every login, cron at every boot, Task Scheduler whenever it notices
      // a start it missed. Each of those is how a run the machine was off for eventually
      // happens — and each would otherwise also fire on days when nothing was missed. So
      // the first thing a scheduled run does is ask whether its occurrence is already
      // covered, and if it is, it stops here having opened no session and sent no request.
      if (values.scheduled) {
        const due = schedule.isDue(config.schedule, await schedule.loadLastRun());
        if (!due) {
          stdout.write('  Already up to date for today; nothing to do.\n');
          return 0;
        }
        await schedule.appendLog(`${new Date().toISOString()}  START   scheduled run`);
      }
      const session = await loadSession();
      if (!session) {
        stdout.write('  Not signed in. Run: care-album-saver login\n');
        return 1;
      }
      const client = new BrightwheelClient({
        session: session.session,
        userAgent: session.userAgent,
        baseUrl,
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
            await schedule.appendLog(`${new Date().toISOString()}  SKIPPED another run was already saving photos`);
          }
          return 0;
        }
        // A scheduled run fails at seven in the evening with nobody watching. Unless the
        // failure is written down, the tool has no way to answer "is this still working?"
        // — and an expired session looks exactly like an archive that is up to date.
        if (values.scheduled) {
          await schedule.appendLog(
            `${new Date().toISOString()}  FAILED  ${scrub(error instanceof Error ? error.message : String(error))}`,
          );
          await schedule.recordRun({
            at: new Date().toISOString(),
            ok: false,
            saved: 0,
            failed: 0,
            message: scrub(error instanceof Error ? error.message : String(error)),
            trigger: 'schedule',
          });
          // And say so where somebody will see it. The record answers the question; this
          // is what makes anyone ask it. Fixed text — the error is not in it — and a
          // desktop with no notifier just means the record is the only trace.
          await schedule.notify(schedule.FAILED_NOTICE).catch(() => false);
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
          `${new Date().toISOString()}  ${result.failed === 0 && !result.stopped ? 'OK     ' : 'PARTIAL'}  ` +
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
