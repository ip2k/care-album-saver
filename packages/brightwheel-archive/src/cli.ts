#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { BrightwheelClient } from './api/client.js';
import { loadConfig, loadSession, normaliseCookieInput, saveConfig, saveSession } from './config.js';
import { configDir, configPath, sessionPath } from './paths.js';
import { scrub } from './secrets.js';
import { sync } from './sync.js';
import { startWebUi } from './web/server.js';
import { formatReport, verify } from './verify.js';

const HELP = `
brightwheel-archive — save your own child's photos from Brightwheel

  brightwheel-archive setup        Open the setup assistant in your browser (easiest)
  brightwheel-archive login        Paste your Brightwheel session in the terminal
  brightwheel-archive run          Save any new photos (Ctrl+C stops after the current one)
  brightwheel-archive children     List the children on your account, with their ids
  brightwheel-archive doctor       Check that everything is working
  brightwheel-archive verify       Check the Brightwheel API shape (read-only, no photos)
    --deep                         ...and read three photos to find the real capture time
  brightwheel-archive where        Show where files are kept

Options
  --dir <path>       Where to save photos (default: ~/Brightwheel Photos)
  --all              Re-check every photo, not just new ones
  --no-name-tag      Do not write any name into the photo metadata
  --child <id|name>  Only this child, for this run (repeat for several; your saved
                     settings are not changed)
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
      stdout.write(`Photos:   ${config.archiveDir}\nSettings: ${configPath()}\nSession:  ${sessionPath()}\n`);
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
      const rl = createInterface({ input: stdin, output: stdout });
      stdout.write(
        `\n  Sign in at https://schools.mybrightwheel.com in your browser.\n` +
          `  Then open developer tools (F12), go to Application > Cookies,\n` +
          `  and copy the value of the cookie named _brightwheel_v2.\n\n`,
      );
      const pasted = await rl.question('  Paste it here: ');
      rl.close();
      const secret = normaliseCookieInput(pasted);
      if (!secret) {
        stdout.write('\n  That did not look like a session value. Nothing was saved.\n');
        return 1;
      }
      const client = new BrightwheelClient({ session: secret, baseUrl });
      const check = await client.verifySession();
      if (!check.ok) {
        stdout.write(`\n  Could not sign in: ${scrub(check.reason)}\n`);
        return 1;
      }
      await saveSession(secret, check.email);
      await saveConfig(config);
      stdout.write(`\n  Signed in${check.email ? ` as ${check.email}` : ''}. Now run: brightwheel-archive run\n`);
      return 0;
    }

    case 'children': {
      const session = await loadSession();
      if (!session) {
        stdout.write('  Not signed in. Run: brightwheel-archive login\n');
        return 1;
      }
      const client = new BrightwheelClient({ session: session.session, baseUrl });
      const me = await client.me();
      const children = await client.students(me.id);
      const width = Math.max(...children.map((c) => c.fullName.length));
      for (const child of children) {
        stdout.write(
          `  ${child.fullName.padEnd(width)}  id: ${child.id}${child.schoolName ? `  (${child.schoolName})` : ''}\n`,
        );
      }
      stdout.write(`\n  To save photos for some of them only: brightwheel-archive run --child <id or name>\n`);
      return 0;
    }

    case 'doctor': {
      const session = await loadSession();
      stdout.write(`  Config folder: ${configDir()}\n`);
      stdout.write(`  Photos folder: ${config.archiveDir}\n`);
      stdout.write(`  Session saved: ${session ? `yes (${session.session.fingerprint()})` : 'no'}\n`);
      if (!session) return 1;
      const client = new BrightwheelClient({ session: session.session, baseUrl });
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
      return check.ok ? 0 : 1;
    }

    case 'verify': {
      const session = await loadSession();
      if (!session) {
        stdout.write('  Not signed in. Run: brightwheel-archive setup\n');
        return 1;
      }
      try {
        const report = await verify(session.session, { baseUrl, deep: values.deep });
        stdout.write(formatReport(report));
        stdout.write('  This output is safe to share.\n\n');
        return report.sessionValid ? 0 : 1;
      } catch (error) {
        stdout.write(`\n  Verification failed: ${scrub(error instanceof Error ? error.message : String(error))}\n`);
        return 1;
      }
    }

    case 'run': {
      const session = await loadSession();
      if (!session) {
        stdout.write('  Not signed in. Run: brightwheel-archive login\n');
        return 1;
      }
      const client = new BrightwheelClient({
        session: session.session,
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
            stdout.write(`  No child called "${wanted}" on this account. Run: brightwheel-archive children\n`);
            return 1;
          }
          if (!chosen.includes(match.id)) chosen.push(match.id);
        }
        config.includeStudents = chosen;
        stdout.write(`  Only: ${children.filter((c) => chosen.includes(c.id)).map((c) => c.fullName).join(', ')}\n`);
      }
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
      } finally {
        process.off('SIGINT', onInterrupt);
      }
      stdout.write(
        `\n  ${result.stopped ? 'Stopped' : 'Done'}. ${result.saved} new, ${result.skipped} already had, ` +
          `${result.failed} failed.\n  Photos are in: ${result.archiveDir}\n`,
      );
      if (result.stopped) stdout.write('  Run the same command again to carry on where it left off.\n');
      for (const w of result.warnings) stdout.write(`  Note: ${scrub(w)}\n`);
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
