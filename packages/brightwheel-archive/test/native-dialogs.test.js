// First, before anything that can read the config directory: points this file at a
// throwaway one even when it is run on its own with `node --test`, which applies no
// --import (see scripts/test-env.js).
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startMockBrightwheel,
  startWebUi,
  writeSecureFile,
  configPath,
  DEFAULT_CONFIG,
} from '../dist/index.js';
import { chooseFolder, openFolder } from '../dist/native.js';

/**
 * Choosing a folder with the operating system's own dialog, and opening the archive in the
 * file manager.
 *
 * These are the two endpoints that make a process start on the parent's machine, so most of
 * what is checked here is what they refuse: a request with no token or from another site, a
 * folder the tool would not accept if it had been typed, and a path in the body of
 * /api/open-folder, which is ignored in favour of the stored one.
 *
 * No test can click a real dialog, and none should open windows on the machine running it,
 * so `native.spawn` is a stand-in that records what it was asked to run. What it records is
 * the evidence for the other half: the program is always launched with an argument ARRAY,
 * never a command line, so nothing a folder is named can be read as a command.
 */

let mock;
const SESSION = 'test-session-value';

before(assertIsolatedConfigDir);
before(async () => { mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 2 }); });
after(async () => { await mock?.close(); });

/**
 * A config directory of this test's own, so that a folder stored by one test is not the
 * starting point of the next. `configDir()` reads the environment on every call, and node
 * runs the tests in a file one at a time.
 */
async function freshConfigDir() {
  process.env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'bw-native-'));
  delete process.env.BRIGHTWHEEL_SESSION;
  return assertIsolatedConfigDir();
}

/**
 * A stand-in for execFile that answers with whatever the test says, and remembers every
 * call. `replies` is consulted per program name; anything not named is reported as missing,
 * which is how a computer without zenity behaves.
 */
/**
 * Somewhere the archive-destination rule actually permits. mkdtemp is refused by design,
 * and the home folder belongs to the person running the suite, so this is what is left.
 * node_modules must exist for the suite to run at all, and .cache inside it is gitignored.
 */
const REAL_PHOTOS_ROOT = fileURLToPath(new URL('../../../node_modules/.cache/bw-native-test/', import.meta.url));
after(async () => { await rm(REAL_PHOTOS_ROOT, { recursive: true, force: true }); });

function recorder(replies = {}) {
  const calls = [];
  const spawn = async (file, args, timeoutMs) => {
    calls.push({ file, args, timeoutMs });
    const reply = replies[file];
    if (!reply) return { code: -1, stdout: '', stderr: '', missing: true };
    return { code: 0, stdout: '', stderr: '', ...(typeof reply === 'function' ? await reply(file, args) : reply) };
  };
  return { calls, spawn };
}

/** A setup UI with a stand-in chooser, plus the small client the page itself is. */
async function setupUi({ native, connect = false } = {}) {
  const handle = await startWebUi({ baseUrl: `${mock.url}/api/v1`, native });
  const call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-setup-token': handle.token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  if (connect) {
    const session = await call('/api/session', { cookie: SESSION });
    assert.equal(session.status, 200, 'connecting to the mock must work');
  }
  return { handle, call };
}

/** A macOS chooser that returns `path`, or cancels when it is null. */
const macChooser = (path) =>
  recorder({
    osascript: path === null
      ? { code: 1, stderr: 'execution error: User canceled. (-128)' }
      : { code: 0, stdout: `${path}\n` },
  });

// ---------------------------------------------------------------- choosing a folder

test('a picked folder is stored, and the dialog is opened with an argument array', async () => {
  await freshConfigDir();
  const native = macChooser('/Users/alex/Pictures/Brightwheel');
  const { handle, call } = await setupUi({ native: { platform: 'darwin', spawn: native.spawn } });
  try {
    const picked = await call('/api/choose-folder', {});
    assert.equal(picked.status, 200, JSON.stringify(picked.body));
    assert.equal(picked.body.ok, true);
    assert.equal(picked.body.config.archiveDir, '/Users/alex/Pictures/Brightwheel');

    const state = await call('/api/state');
    assert.equal(state.body.config.archiveDir, '/Users/alex/Pictures/Brightwheel', 'persisted like a typed one');

    assert.equal(native.calls.length, 1);
    const [only] = native.calls;
    assert.equal(only.file, 'osascript');
    assert.ok(Array.isArray(only.args), 'an argument array, never a command line');
    assert.deepEqual(only.args, ['-e', 'POSIX path of (choose folder with prompt "Choose where to save your photos")']);
  } finally {
    await handle.close();
  }
});

test('cancelling the dialog changes nothing at all', async () => {
  await freshConfigDir();
  const native = macChooser(null);
  const { handle, call } = await setupUi({ native: { platform: 'darwin', spawn: native.spawn } });
  try {
    const before = (await call('/api/state')).body.config.archiveDir;
    const cancelled = await call('/api/choose-folder', {});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.cancelled, true, 'a plain "cancelled", not an error');
    assert.equal(cancelled.body.config, undefined, 'nothing was saved');

    const after = (await call('/api/state')).body.config.archiveDir;
    assert.equal(after, before, 'the stored folder is untouched');
  } finally {
    await handle.close();
  }
});

test('a picked folder meets exactly the refusals a typed one does', async () => {
  await freshConfigDir();
  // The picker must not become a way around checkArchiveDir. A temporary folder is emptied
  // by the operating system, and a system folder is none of this tool's business, whether
  // the parent typed the path or a dialog handed it over.
  const temporary = await mkdtemp(join(tmpdir(), 'bw-picked-'));
  for (const [picked, complaint] of [[temporary, /temporary folder/i], ['/System/Library/Fonts', /operating system/i]]) {
    const native = macChooser(picked);
    const { handle, call } = await setupUi({ native: { platform: 'darwin', spawn: native.spawn } });
    try {
      const before = (await call('/api/state')).body.config.archiveDir;
      const refused = await call('/api/choose-folder', {});
      assert.equal(refused.status, 400, `${picked} should be refused`);
      assert.equal(refused.body.ok, false);
      assert.equal(refused.body.field, 'archiveDir', 'the page needs to know which control to mark');
      assert.match(refused.body.error, complaint);
      assert.doesNotMatch(refused.body.error, /archiveDir|ENOENT|null/, 'no developer words');

      const after = (await call('/api/state')).body.config.archiveDir;
      assert.equal(after, before, 'a refused pick stores nothing');
    } finally {
      await handle.close();
    }
  }
  await rm(temporary, { recursive: true, force: true });
});

test('a picked cloud folder is warned about rather than silently accepted', async () => {
  await freshConfigDir();
  const native = macChooser('/Users/alex/Dropbox/Nursery photos');
  const { handle, call } = await setupUi({ native: { platform: 'darwin', spawn: native.spawn } });
  try {
    const picked = await call('/api/choose-folder', {});
    assert.equal(picked.status, 200);
    assert.equal(picked.body.ok, true, 'allowed, because it can be a deliberate choice');
    assert.match(picked.body.warning, /Dropbox/, 'but never by accident');
  } finally {
    await handle.close();
  }
});

test('a computer with no chooser says so plainly, and typing a path still works', async () => {
  await freshConfigDir();
  // A Linux desktop with neither zenity nor kdialog installed: both report "missing".
  const native = recorder({});
  const { handle, call } = await setupUi({ native: { platform: 'linux', spawn: native.spawn } });
  try {
    const none = await call('/api/choose-folder', {});
    assert.equal(none.status, 200, 'not a failed request: it is the answer');
    assert.equal(none.body.ok, false);
    assert.match(none.body.error, /zenity or kdialog/);
    assert.match(none.body.error, /type the full path/i, 'points at the fallback that is still there');
    assert.deepEqual(native.calls.map((c) => c.file), ['zenity', 'kdialog'], 'both were tried');

    const typed = await call('/api/config', { archiveDir: '/Users/alex/Pictures/Brightwheel' });
    assert.equal(typed.status, 200, 'the typed field is unaffected');
    assert.equal(typed.body.config.archiveDir, '/Users/alex/Pictures/Brightwheel');
  } finally {
    await handle.close();
  }
});

test('only one folder chooser may be open at a time', async () => {
  await freshConfigDir();
  // The dialog blocks until it is answered. Without this guard a second click leaves two
  // modal windows fighting for the screen and two processes waiting on them.
  let release;
  // Released on a timer as well as by hand, so that a regression letting the second request
  // through fails the assertion below instead of deadlocking this file.
  const held = new Promise((resolve) => {
    release = resolve;
    setTimeout(resolve, 2000).unref();
  });
  let opened = false;
  const native = recorder({
    osascript: async () => {
      opened = true;
      await held;
      return { code: 1, stderr: 'execution error: User canceled. (-128)' };
    },
  });
  const { handle, call } = await setupUi({ native: { platform: 'darwin', spawn: native.spawn } });
  try {
    const first = call('/api/choose-folder', {});
    while (!opened) await new Promise((r) => setTimeout(r, 5));

    const second = await call('/api/choose-folder', {});
    assert.equal(second.status, 409);
    assert.match(second.body.error, /already open/i);

    release();
    assert.equal((await first).body.cancelled, true);
    assert.equal(native.calls.length, 1, 'the second request never reached the operating system');

    // And the guard is released afterwards, so the next click still works.
    const again = await call('/api/choose-folder', {});
    assert.equal(again.status, 200);
  } finally {
    await handle.close();
  }
});

// ---------------------------------------------------------------- opening the folder

test('/api/open-folder ignores a path in the body and opens the configured folder', async () => {
  await freshConfigDir();
  // NOT the test run's own archive folder, which is a temp directory: the route re-checks
  // the stored destination against the same rule that governs where photos may be saved,
  // and temp directories are refused outright because the operating system empties them.
  // A folder under node_modules/.cache is the one durable, gitignored place a test has.
  const configured = join(REAL_PHOTOS_ROOT, 'open-me');
  await mkdir(configured, { recursive: true });
  const native = recorder({ open: { code: 0 } });
  const { handle, call } = await setupUi({ native: { platform: 'darwin', spawn: native.spawn } });
  try {
    // Stored the way a parent stores it, through the endpoint that validates it.
    const saved = await call('/api/config', { archiveDir: configured });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const opened = await call('/api/open-folder', { path: '/etc', dir: '/System', archiveDir: '/Users/alex/elsewhere' });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.ok, true);
    assert.equal(opened.body.path, configured);

    assert.equal(native.calls.length, 1);
    const [only] = native.calls;
    assert.equal(only.file, 'open');
    assert.deepEqual(only.args, [configured], 'the stored folder, and nothing from the request');
    assert.equal(JSON.stringify(native.calls).includes('/etc'), false, 'no path from the body reached the system');
  } finally {
    await handle.close();
  }
});

test('/api/open-folder says plainly when the folder has not been made yet', async () => {
  await freshConfigDir();
  const native = recorder({ open: { code: 0 } });
  const { handle, call } = await setupUi({ native: { platform: 'darwin', spawn: native.spawn } });
  try {
    await call('/api/config', { archiveDir: '/Users/alex/Pictures/Not yet' });
    const opened = await call('/api/open-folder', {});
    assert.equal(opened.status, 200);
    assert.equal(opened.body.ok, false);
    assert.match(opened.body.error, /does not exist yet/i);
    assert.match(opened.body.error, /first time photos are saved/i, 'says when it will be there');
    assert.equal(native.calls.length, 0, 'nothing was launched');
  } finally {
    await handle.close();
  }
});

// ---------------------------------------------------------------- the guards above every route

/**
 * `fetch` refuses to set a Host header — it is a forbidden header name in undici — so a
 * rebinding attack cannot be simulated through it. The raw client can, which is exactly why
 * the server must not trust the header.
 */
function rawPost(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

test('both routes are refused without the token, cross-site, and on GET', async () => {
  await freshConfigDir();
  const native = recorder({ osascript: { code: 0, stdout: '/Users/alex/Pictures/Brightwheel' }, open: { code: 0 } });
  const { handle } = await setupUi({ native: { platform: 'darwin', spawn: native.spawn } });
  const at = (path) => `http://127.0.0.1:${handle.port}${path}`;
  try {
    for (const path of ['/api/choose-folder', '/api/open-folder']) {
      const noToken = await fetch(at(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(noToken.status, 403, `${path} without the token`);

      const wrongToken = await fetch(at(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-setup-token': 'not-the-token' },
        body: '{}',
      });
      assert.equal(wrongToken.status, 403, `${path} with a guessed token`);

      // A page the parent is merely visiting. The browser labels the request, and this is
      // where that label is spent.
      const crossSite = await fetch(at(`${path}?token=${handle.token}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        body: '{}',
      });
      assert.equal(crossSite.status, 403, `${path} from another site`);

      // The rebinding shape: the attacker's own domain resolved to 127.0.0.1, so the
      // browser treats it as same-origin and sends the request with that Host.
      const rebound = await rawPost(handle.port, `${path}?token=${handle.token}`, { Host: 'evil.example.com' });
      assert.equal(rebound.status, 403, `${path} with a rebound host name`);

      // POST only, so none of the shapes a page can emit unaided — an image, a stylesheet,
      // a redirect, a plain link — can reach it.
      const asGet = await fetch(at(`${path}?token=${handle.token}`));
      assert.equal(asGet.status, 404, `${path} as a GET`);
    }
    assert.equal(native.calls.length, 0, 'not one refused request reached the operating system');
  } finally {
    await handle.close();
  }
});

// ---------------------------------------------------------------- never a shell

test('a folder named like a command is one argument, not a command line', async () => {
  // The whole reason for execFile with an argument array. If any of this were ever pasted
  // into a shell string, this folder name would delete a home directory.
  const hostile = '/Users/alex/Pictures/; rm -rf ~';
  const chooser = recorder({ osascript: { code: 0, stdout: `${hostile}\n` } });
  const choice = await chooseFolder({ platform: 'darwin', spawn: chooser.spawn });
  assert.deepEqual(choice, { ok: true, path: hostile }, 'reported back exactly, and not interpreted');

  const opener = recorder({ open: { code: 0 } });
  const opened = await openFolder(hostile, { platform: 'darwin', spawn: opener.spawn });
  // The folder does not exist, so it never reaches the file manager — which is itself the
  // answer: openFolder will not launch anything for a path that is not a real directory.
  assert.equal(opened.ok, false);
  assert.equal(opener.calls.length, 0);

  // And for a folder that does exist, the whole name travels as one argv element.
  const real = process.env.BRIGHTWHEEL_ARCHIVE_DIR;
  const live = recorder({ open: { code: 0 } });
  assert.deepEqual(await openFolder(real, { platform: 'darwin', spawn: live.spawn }), { ok: true });
  assert.deepEqual(live.calls[0].args, [real]);
});

test('openFolder refuses a path that could be read as a flag', async () => {
  // argv has no quoting: a "folder" called -R would reach `open` as an option, not a path.
  // Requiring an absolute path means the first character can never be a dash.
  const native = recorder({ open: { code: 0 }, 'explorer.exe': { code: 1 } });
  for (const bad of ['-R', '--version', 'Pictures/Brightwheel', '', '   ']) {
    const refused = await openFolder(bad, { platform: 'darwin', spawn: native.spawn });
    assert.equal(refused.ok, false, `${JSON.stringify(bad)} should be refused`);
    // Refused for being the wrong shape, not merely because nothing happens to be there:
    // a relative path names a real folder whenever the tool is started from the right
    // place, and that must not be the difference between refusing and launching.
    assert.match(refused.error, /no folder to open yet/i, `${JSON.stringify(bad)} is refused on its shape`);
  }
  assert.equal(native.calls.length, 0, 'nothing was launched');
});

test('the choosers and openers of every platform are argument arrays', async () => {
  // Windows Explorer exits 1 even when it opened the window, so its exit code is not read.
  const windows = recorder({ 'explorer.exe': { code: 1, stderr: '' } });
  const real = process.env.BRIGHTWHEEL_ARCHIVE_DIR;
  assert.deepEqual(await openFolder(real, { platform: 'win32', spawn: windows.spawn }), { ok: true });
  assert.deepEqual(windows.calls[0], { file: 'explorer.exe', args: [real], timeoutMs: windows.calls[0].timeoutMs });

  const linux = recorder({ gio: { code: 0 } });
  assert.deepEqual(await openFolder(real, { platform: 'linux', spawn: linux.spawn }), { ok: true });
  assert.deepEqual(linux.calls.map((c) => c.file), ['xdg-open', 'gio'], 'falls back when xdg-open is absent');
  assert.deepEqual(linux.calls[1].args, ['open', real]);

  const zenity = recorder({ zenity: { code: 0, stdout: '/home/alex/Pictures/Brightwheel' } });
  assert.deepEqual(await chooseFolder({ platform: 'linux', spawn: zenity.spawn }), {
    ok: true,
    path: '/home/alex/Pictures/Brightwheel',
  });
  assert.deepEqual(zenity.calls[0].args, ['--file-selection', '--directory', '--title=Choose where to save your photos']);

  // Windows prints nothing and still exits 0 when the dialog is dismissed.
  const powershell = recorder({ 'powershell.exe': { code: 0, stdout: '' } });
  assert.deepEqual(await chooseFolder({ platform: 'win32', spawn: powershell.spawn }), { ok: false, cancelled: true });
  const [ps] = powershell.calls;
  assert.equal(ps.args[0], '-NoProfile', 'a customised profile cannot change what the script does');
  assert.ok(ps.args.includes('-STA'), 'FolderBrowserDialog needs a single-threaded apartment');
  assert.ok(ps.args[ps.args.length - 1].includes('FolderBrowserDialog'), 'the script is the last argument');
});

test('native.ts never reaches for a shell', async () => {
  // A source check, because this is the one property no stand-in can demonstrate: the real
  // spawner has to be execFile with an array, and must never grow a `shell: true`.
  const source = await readFile(fileURLToPath(new URL('../dist/native.js', import.meta.url)), 'utf8');
  assert.match(source, /execFile\(/, 'execFile is how programs are started');
  assert.doesNotMatch(source, /shell\s*:\s*true/, 'never through a shell');
  assert.doesNotMatch(source, /\bexecSync\b|\bspawnSync\b|[^e]\bexec\(/, 'no shell-interpreting relative of execFile');
});

// ---------------------------------------------------------------- the page

test('the page offers the chooser and the open button, and both go through the token', async () => {
  await freshConfigDir();
  const { handle } = await setupUi({ native: { platform: 'darwin', spawn: recorder({}).spawn } });
  try {
    const html = await (await fetch(`http://127.0.0.1:${handle.port}/?token=${handle.token}`)).text();

    assert.ok(html.includes('id="btn-choose-dir"'), 'a button that opens the real folder chooser');
    assert.ok(html.includes('id="btn-open-dir"'), 'a button that opens the folder in the file manager');
    assert.ok(html.includes('id="archiveDir"'), 'and the typed field stays, for a computer with no chooser');

    const choose = html.slice(html.indexOf("$('btn-choose-dir').onclick"));
    assert.match(choose.slice(0, 1400), /api\('\/api\/choose-folder', \{ method: 'POST'/, 'posts through the token helper');
    assert.match(choose.slice(0, 1400), /d\.cancelled/, 'cancelling is handled as an ordinary answer');
    assert.match(choose.slice(0, 1400), /showSaveError/, 'a refused pick is marked where a typed one is');
    assert.ok(!choose.slice(0, 1400).includes('fetch('), 'never a bare fetch, which would arrive without the token');

    const open = html.slice(html.indexOf('async function openArchiveFolder'));
    assert.match(open.slice(0, 900), /api\('\/api\/open-folder', \{ method: 'POST'/);
    assert.ok(!open.slice(0, 900).includes("path:"), 'the page sends no path: the tool opens the folder it has stored');

    // "Where did my photos go" is asked at the end of a run, not in the settings drawer.
    assert.ok(html.includes('id="btn-open-done"'), 'the finished-run summary offers it too');
    assert.match(html, /if \(result\) offerOpenFolder\(\);/);

    // Room around the note under the buttons, so the small text is not hugging them.
    assert.match(html, /\.dir-note \{[^}]*margin: var\(--s3\) 0 0/);
    assert.match(html, /\.dir-actions \{[^}]*gap: var\(--s3\)/);
  } finally {
    await handle.close();
  }
});

test('opening the folder refuses a destination the tool would not archive into', async () => {
  // config.json is an ordinary file in the parent's own directory. A hand edit, an older
  // build, or a bug in a neighbouring route can put anything in archiveDir — and without a
  // check here, "open my photos folder" becomes "open any absolute path on this machine".
  // A checker got /etc and an application bundle opened this way before the re-validation.
  await freshConfigDir();
  const spawned = [];
  const { handle, call } = await setupUi({
    connect: false,
    native: { spawn: async (file, args) => { spawned.push([file, args]); return { code: 0, stdout: '', stderr: '' }; } },
  });
  try {
    // Written straight to the file, as a hand edit would be: the API would refuse it.
    await writeSecureFile(configPath(), JSON.stringify({ ...DEFAULT_CONFIG, archiveDir: '/etc' }, null, 2));

    const res = await call('/api/open-folder', {});
    assert.equal(res.status, 400, '/etc is not a folder this tool archives into');
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /operating system/i, 'and it says why in plain words');
    assert.deepEqual(spawned, [], 'nothing was launched');
  } finally {
    await handle.close();
  }
});

test('a chooser that is broken rather than dismissed is not reported as a cancellation', async () => {
  // zenity exits 1 both when the person presses Cancel and when it cannot reach a display.
  // Reading the code alone told a parent "No folder was chosen" on a machine where no
  // dialog ever appeared — and returned before kdialog, the one that might have worked,
  // was tried. What separates them is that a failure complains and a dismissal is silent.
  const broken = recorder({
    zenity: { code: 1, stderr: 'Unable to init server: Could not connect: Connection refused' },
    kdialog: { code: 0, stdout: '/home/alex/Pictures\n' },
  });
  const chosen = await chooseFolder({ platform: 'linux', spawn: broken.spawn });
  assert.deepEqual(chosen, { ok: true, path: '/home/alex/Pictures' }, 'it moved on to the one that works');
  assert.deepEqual(broken.calls.map((c) => c.file), ['zenity', 'kdialog']);

  // And a real dismissal, which says nothing, still reads as a dismissal and stops there.
  const dismissed = recorder({ zenity: { code: 1, stderr: '' }, kdialog: { code: 0, stdout: '/home/alex/x\n' } });
  assert.deepEqual(await chooseFolder({ platform: 'linux', spawn: dismissed.spawn }), { ok: false, cancelled: true });
  assert.deepEqual(dismissed.calls.map((c) => c.file), ['zenity'], 'a dismissal is an answer, not a failure to try again');
});
