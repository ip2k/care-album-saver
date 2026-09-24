#!/usr/bin/env node
/**
 * A throwaway copy of the setup page, for trying changes by hand.
 *
 *     pnpm run build && node scripts/demo.js [--port 4719] [--photos-deny]
 *
 * Everything in it is invented and nothing it does reaches anything real:
 *
 *  - Brightwheel is the mock from src/mock/server.ts: Robin and Sam Maple, with pictures
 *    drawn on the spot. Paste `demo-session` as the session value.
 *  - Settings, the saved session and the daily log live in fresh temporary folders.
 *  - Photos are saved under node_modules/.cache/care-album-saver-demo — unless you choose a
 *    different folder in the page, which is real: the folder chooser is the operating
 *    system's own, and invented photos would then be saved where you pointed it.
 *  - "Save new photos every day" talks to a pretend scheduler. The real one is never
 *    touched, so a daily run already set up on this computer is neither changed nor removed.
 *  - "Add new photos to the Photos app" is pretended too, and each call it would have made
 *    is printed here instead. With --photos-deny, it answers the way a Mac does when
 *    permission has been refused, so that failure can be seen.
 *
 * Stop it with Ctrl+C; the temporary folders and the demo photos are deleted on the way out.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { port: { type: 'string', default: '4719' }, 'photos-deny': { type: 'boolean', default: false } },
});

// Before anything reads them: every module asks for these folders when it needs them, and
// the defaults are the real ones.
const configDir = mkdtempSync(join(tmpdir(), 'cas-demo-config-'));
const logDir = mkdtempSync(join(tmpdir(), 'cas-demo-logs-'));
const fakeHome = mkdtempSync(join(tmpdir(), 'cas-demo-home-'));
process.env.CARE_ALBUM_CONFIG_DIR = configDir;
process.env.CARE_ALBUM_LOG_DIR = logDir;
delete process.env.CARE_ALBUM_SESSION;
delete process.env.BRIGHTWHEEL_SESSION;
// Temporary folders are refused as a destination by design, so the demo archive sits in
// node_modules, which is gitignored and deleted on the way out.
const photos = fileURLToPath(new URL('../node_modules/.cache/care-album-saver-demo', import.meta.url));
mkdirSync(photos, { recursive: true });

const dist = new URL('../packages/care-album-saver/dist/', import.meta.url);
const { startMockBrightwheel, startWebUi, writeSecureFile, configPath, DEFAULT_CONFIG, PHOTOS_SCRIPT } = await import(
  new URL('index.js', dist).href
);
const { runProgram } = await import(new URL('native.js', dist).href);

await writeSecureFile(configPath(), JSON.stringify({ ...DEFAULT_CONFIG, archiveDir: photos, delayMs: 150 }, null, 2));

const SESSION = 'demo-session';
const say = (line) => process.stdout.write(`  [demo] ${line}\n`);

/** The Photos app, pretended. Everything else — the folder chooser, Finder — is real. */
const spawn = async (file, args, timeoutMs) => {
  if (file === 'osascript' && args[0] === PHOTOS_SCRIPT) {
    const at = args.indexOf('--');
    const shown =
      at < 0 ? '(no files: the permission check)' : `${args.slice(1, at).join(' › ')}  ←  ${args.length - at - 1} file(s)`;
    say(`Photos would have run: add-to-photos.applescript ${shown}`);
    if (values['photos-deny']) {
      return { code: 1, stdout: '', stderr: 'execution error: Not authorized to send Apple events to Photos. (-1743)' };
    }
    return { code: 0, stdout: at < 0 ? 'ok\n' : `${args.length - at - 1}\n`, stderr: '' };
  }
  return runProgram(file, args, timeoutMs);
};

/** launchd, pretended: it remembers what it was told and answers accordingly. */
let registered = false;
const run = async (file, args) => {
  if (file === 'launchctl') {
    if (args[0] === 'bootstrap') registered = true;
    if (args[0] === 'bootout') registered = false;
    say(`scheduler would have run: launchctl ${args.join(' ')}`);
    return { code: args[0] === 'print' && !registered ? 113 : 0, stdout: '', stderr: '' };
  }
  return { code: 0, stdout: '', stderr: '' };
};

const mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 24 });
const ui = await startWebUi({
  baseUrl: `${mock.url}/api/v1`,
  port: Number(values.port),
  native: { spawn },
  schedule: { home: fakeHome, run, platform: 'darwin' },
  banner: 'Demo — the children, photos, Photos app and daily run here are all pretend. Nothing on this computer is changed.',
});

process.stdout.write(
  `\n  Care Album Saver — demo (everything here is invented)\n\n` +
    `  Open:           ${ui.url}\n` +
    `  Session value:  ${SESSION}\n` +
    `  Photos app:     pretended${values['photos-deny'] ? ', and it says no' : ''}; calls are printed below\n` +
    `  Daily run:      pretended; the real scheduler is not touched\n\n` +
    `  Ctrl+C to stop and clean up.\n\n`,
);

let stopping = false;
const stop = async () => {
  if (stopping) process.exit(130);
  stopping = true;
  await ui.close().catch(() => {});
  await mock.close().catch(() => {});
  for (const dir of [configDir, logDir, fakeHome, photos]) rmSync(dir, { recursive: true, force: true });
  process.stdout.write('\n  Demo stopped; its folders are deleted.\n');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
