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

const HELP = `
brightwheel-archive — save your own child's photos from Brightwheel

  brightwheel-archive setup        Open the setup assistant in your browser (easiest)
  brightwheel-archive login        Paste your Brightwheel session in the terminal
  brightwheel-archive run          Save any new photos
  brightwheel-archive children     List the children on your account
  brightwheel-archive doctor       Check that everything is working
  brightwheel-archive where        Show where files are kept

Options
  --dir <path>       Where to save photos (default: ~/Brightwheel Photos)
  --all              Re-check every photo, not just new ones
  --no-name-tag      Do not write your child's name into the photo metadata
  --port <number>    Port for the setup assistant
  --base-url <url>   Point at a different API (used by the tests)
  --help             Show this message

Your session is stored in your user config folder, never in this project folder:
  ${configDir()}
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      all: { type: 'boolean' },
      'no-name-tag': { type: 'boolean' },
      port: { type: 'string' },
      'base-url': { type: 'string' },
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
      await new Promise<void>((resolve) => process.on('SIGINT', () => resolve()));
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
      for (const child of await client.students(me.id)) {
        stdout.write(`  ${child.fullName}${child.schoolName ? `  (${child.schoolName})` : ''}\n`);
      }
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
      let lastLine = '';
      const result = await sync(client, config, (p) => {
        const line = `  ${p.message}`;
        if (line !== lastLine) {
          stdout.write(`${line}\n`);
          lastLine = line;
        }
      });
      stdout.write(
        `\n  Done. ${result.saved} new, ${result.skipped} already had, ${result.failed} failed.\n` +
          `  Photos are in: ${result.archiveDir}\n`,
      );
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
    const message = error instanceof Error ? error.message : String(error);
    stdout.write(`\n  ${scrub(message)}\n`);
    process.exit(1);
  });
