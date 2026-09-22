// First, before anything that can read the config directory: points this file at a
// throwaway one even when it is run on its own with `node --test`, which applies no
// --import (see scripts/test-env.js).
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { startMockBrightwheel, startWebUi, writeSecureFile } from '../dist/index.js';

/**
 * Stopping a run part-way, and the three ways the setup page used to leave a parent with
 * no explanation on screen: a refusal wiped out by the next save, an empty list of
 * children with nothing said about it, and children chosen before there was an account to
 * choose them from.
 *
 * The server half runs over real HTTP against the mock. The page's own script cannot: it
 * is a browser script and this suite has no browser — Playwright is here to capture the
 * guide's screenshots, and CI's test job installs no Chromium — so the page is checked by
 * reading the script it serves, as child-selection-ux.test.js does.
 */

let mock;
const SESSION = 'test-session-value';
const ROBIN = 'stu-aaa-111';
const SAM = 'stu-bbb-222';

before(assertIsolatedConfigDir);
before(async () => { mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 6 }); });
after(async () => { await mock?.close(); });

/**
 * A config directory of this test's own. `configDir()` reads the environment on every
 * call, so re-pointing the variable hands a test a computer the tool has never been set up
 * on, which is the state most of the refusals below are about. Node runs the tests in a
 * file one at a time, so there is no other test to pull the directory out from under.
 */
async function freshConfigDir() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'bw-ui-'));
  // loadSession() prefers this variable over the stored file, so a developer who has it
  // set in their shell would otherwise be "connected" in a directory holding no session.
  delete process.env.CARE_ALBUM_SESSION;
  return assertIsolatedConfigDir();
}

/** A setup UI, plus the small client the page itself is: token in a header, JSON both ways. */
async function setupUi({ connect = true } = {}) {
  const handle = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
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

/** The page as served, for the assertions about the script it carries. */
const pageHtml = (handle) =>
  fetch(`http://127.0.0.1:${handle.port}/?token=${handle.token}`).then((r) => r.text());

/** The page's one inline script, as source text. */
function pageScript(html) {
  const open = html.indexOf('<script>');
  const close = html.indexOf('</script>', open);
  assert.ok(open > 0 && close > open, 'the page must carry an inline script');
  assert.equal(html.indexOf('<script', close), -1, 'and exactly one, or this reads the wrong half');
  return html.slice(open + '<script>'.length, close);
}

/** The slice of that script between two markers, so an assertion cannot match elsewhere. */
function section(html, from, to) {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a + 1);
  assert.ok(a > 0 && b > a, `expected the page to contain ${from} ... ${to}`);
  return html.slice(a, b);
}

/**
 * Where a run started through the UI may put its photos. NOT mkdtemp: the tool refuses a
 * temporary folder outright and the web UI, unlike sync() in the other test files, has no
 * way of being told otherwise — which is the point of it. This lives inside node_modules,
 * which is gitignored and has to exist for the suite to run at all, and it is deleted
 * when the file is done.
 */
const PHOTOS_ROOT = fileURLToPath(new URL('../../../node_modules/.cache/bw-web-ui-test/', import.meta.url));
let runs = 0;
async function photosDir() {
  const dir = join(PHOTOS_ROOT, `run-${++runs}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
after(async () => { await rm(PHOTOS_ROOT, { recursive: true, force: true }); });

/** Poll until `check` passes, naming what was being waited for if it never does. */
async function until(check, what, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------- stopping a run

test('/api/stop says plainly when there is nothing to stop, and needs the token', async () => {
  await freshConfigDir();
  const { handle, call } = await setupUi();
  try {
    const idle = await call('/api/stop', {});
    assert.equal(idle.status, 409);
    assert.equal(idle.body.ok, false);
    assert.match(idle.body.error, /nothing is running/i);

    // Token-protected like every other endpoint. A page the parent is merely visiting
    // must not be able to interrupt their run by guessing the port.
    const noToken = await fetch(`http://127.0.0.1:${handle.port}/api/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(noToken.status, 403);
  } finally {
    await handle.close();
  }
});

test('Stop ends a run where it stands, keeps what it saved, and says so in plain words', async () => {
  await freshConfigDir();
  const dir = await photosDir();
  const { handle, call } = await setupUi();
  try {
    // A pause between requests, so that there is a run in progress to interrupt rather
    // than one that is over before the second request arrives.
    const configured = await call('/api/config', { archiveDir: dir, delayMs: 120, incremental: false });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));

    assert.equal((await call('/api/sync', {})).status, 202);
    await until(async () => (await call('/api/state')).body.progress.saved >= 1, 'the run to save its first item');

    const asked = await call('/api/stop', {});
    assert.equal(asked.status, 202, 'the answer comes back at once, not when the run has wound down');
    await handle.stop();

    const state = (await call('/api/state')).body;
    // Asserted, never skipped. This used to degrade to t.skip() when the phase was anything
    // but 'stopped', on the grounds that sync() might not honour options.signal yet — which
    // meant that deleting the whole Stop feature would turn this, the one test named after
    // it, green-with-a-skip. A guard that cannot fail defends nothing.
    assert.equal(
      state.progress.phase,
      'stopped',
      'the run must end as a stop; a run that went to completion means Stop reached nothing',
    );

    assert.equal(state.running, false, 'the run is over, not merely asked to stop');
    assert.equal(state.lastResult.stopped, true, 'and it resolved rather than threw');
    assert.ok(state.progress.saved >= 1);
    assert.match(state.progress.message, /saved so far are kept/i);
    assert.match(state.progress.message, /run again to carry on/i);
    assert.doesNotMatch(state.progress.message, /abort|signal|promise|error/i, 'no developer words');

    // What was already downloaded is still on disk and recorded, so the next run knows.
    const manifest = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));
    assert.equal(manifest.files.length, state.lastResult.saved);

    assert.equal((await call('/api/stop', {})).status, 409, 'and there is nothing left to stop');
  } finally {
    await handle.close();
  }
});

test('closing the server waits for the run to wind down instead of cutting it off', async () => {
  await freshConfigDir();
  const dir = await photosDir();
  const { handle, call } = await setupUi();
  let closed = false;
  try {
    assert.equal((await call('/api/config', { archiveDir: dir, delayMs: 60, incremental: false })).status, 200);
    assert.equal((await call('/api/sync', {})).status, 202);
    await until(async () => (await call('/api/state')).body.progress.saved >= 1, 'the run to save its first item');

    // close() stops the run and waits for it. Without that the process can exit with the
    // manifest still in memory, and every photo already downloaded is fetched again.
    await handle.close();
    closed = true;
    const manifest = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));
    assert.ok(manifest.files.length >= 1, 'the manifest records what the run had already saved');
  } finally {
    if (!closed) await handle.close();
  }
});

// ---------------------------------------------------------------- choosing children

test('children cannot be chosen before there is an account to choose them from', async () => {
  await freshConfigDir();
  const { handle, call } = await setupUi({ connect: false });
  try {
    // Stored unchecked, these ids would silently filter every later run to children who
    // may not even be on the account.
    const refused = await call('/api/config', { includeStudents: [ROBIN] });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.ok, false);
    assert.equal(refused.body.field, 'includeStudents', 'the page needs to know which control to mark');
    assert.match(refused.body.error, /connect/i);
    assert.match(refused.body.error, /step 1/i);
    assert.doesNotMatch(refused.body.error, /includeStudents|array|session|token/i, 'no developer words');

    assert.deepEqual((await call('/api/state')).body.config.includeStudents, [], 'nothing was stored');

    // "All of them" stays expressible: it is the stored default, and the one selection
    // that still means something before step 1.
    const all = await call('/api/config', { includeStudents: [] });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.deepEqual(all.body.config.includeStudents, []);
  } finally {
    await handle.close();
  }
});

test('a stored selection of children who have all left reads as "all", not as nobody', async () => {
  const configDir = await freshConfigDir();
  const { handle, call } = await setupUi();
  try {
    // A child leaves the nursery, or a different account is connected, and the stored id
    // names nobody. Written straight to the file because the UI refuses to store it.
    await writeSecureFile(join(configDir, 'config.json'), JSON.stringify({ includeStudents: ['stu-left-the-nursery'] }));

    const children = await call('/api/children');
    assert.equal(children.status, 200);
    assert.deepEqual(children.body.included, [ROBIN, SAM], 'every box ticked, which is where a fresh setup starts');

    // And the file is tidied the next time it is written, so the two never disagree.
    const saved = await call('/api/config', { tagNote: false });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.config.includeStudents, []);
    assert.deepEqual((await call('/api/state')).body.config.includeStudents, []);

    // A selection that still names somebody is a decision, and is left exactly as it is.
    await call('/api/config', { includeStudents: [SAM] });
    assert.deepEqual((await call('/api/children')).body.included, [SAM]);
    assert.deepEqual((await call('/api/config', { tagNote: true })).body.config.includeStudents, [SAM]);
  } finally {
    await handle.close();
  }
});

// ---------------------------------------------------------------- what the page shows

test('the script the page serves is a script a browser can read', async () => {
  // Every other assertion in this section reads the page's script as TEXT, which a broken
  // script satisfies just as happily as a working one: a stray bracket anywhere in those
  // 400 lines still contains the words being matched, so the whole suite stayed green while
  // the parent's setup page did nothing at all. Compiling it is the cheapest thing that can
  // tell the difference.
  await freshConfigDir();
  const { handle } = await setupUi({ connect: false });
  try {
    const source = pageScript(await pageHtml(handle));

    // Compiled, never run: node:vm parses the whole body and throws a SyntaxError if it
    // cannot, which is the question being asked. Running it would need a browser — there is
    // no document, fetch target or navigator here — and this suite deliberately has none.
    assert.doesNotThrow(
      () => new Script(source, { filename: 'setup-page-script.js' }),
      'the page script must parse, or the setup page is blank for every parent',
    );

    // The page is served as a classic script, not a module, so the compile above has to ask
    // for the same dialect the browser will. A body that only parses as a module would pass
    // a module compile here and still fail in the browser.
    assert.ok(!/^\s*(import|export)\s/m.test(source), 'a classic script has no import or export');
  } finally {
    await handle.close();
  }
});

test('the page keeps a refused folder marked until the folder itself is fixed', async () => {
  await freshConfigDir();
  const { handle } = await setupUi({ connect: false });
  try {
    const html = await pageHtml(handle);
    const save = section(html, 'async function save(patch, opts)', 'function savedNote()');

    // The bug: type a folder the tool refuses, leave the field (refused, marked), then
    // tick any checkbox. That save succeeds, and its success path used to rewrite the
    // folder field from the stored config and clear the mark — reverting what the person
    // had typed and deleting the only thing on screen explaining why.
    const guard = save.indexOf('if (patch.archiveDir !== undefined)');
    assert.ok(guard > 0, 'only the save that carried the folder may touch the folder field');
    assert.ok(save.indexOf("$('archiveDir').value = d.config.archiveDir") > guard);
    // lastIndexOf, not indexOf: the early return for a no-op save clears it too, above.
    assert.ok(save.lastIndexOf('clearDirError()') > guard, 'and only it may drop the mark');
    assert.equal(save.split('clearDirError()').length - 1, 2, 'in exactly those two places');
    assert.equal(save.split("$('archiveDir')").length - 1, 1, 'and it is untouched elsewhere on success');

    // Typing the stored folder back by hand is the one other way the refusal stops being
    // true, and that path returns early — so it must clear the mark on its way past.
    const noop = save.slice(0, save.indexOf('let d;'));
    assert.match(noop, /clearDirError\(\);/, 'a field that again matches what is stored is not refused');

    // The refusal is restored from its own words. Restoring whatever error happened to be
    // in the box would pin an unrelated, transient one there for the rest of the session.
    const note = section(html, 'function savedNote()', '/** The folder is agreed again');
    assert.match(note, /if \(dirError\) el\.innerHTML = /, 'a later "Saved" puts the refusal back');
    assert.ok(!note.includes("querySelector('.msg.err')"), 'and never re-uses an unrelated error');
    assert.match(section(html, 'function showSaveError', 'function updateRunReady'), /dirError = text/);
    assert.match(section(html, 'function clearDirError()', 'function showSaveError'), /aria-invalid', 'false'/);
  } finally {
    await handle.close();
  }
});

test('the page explains an empty selection where the names are, not only to a screen reader', async () => {
  await freshConfigDir();
  const { handle } = await setupUi({ connect: false });
  try {
    const html = await pageHtml(handle);
    const describe = section(html, 'function describeSelection()', "$('btn-connect').onclick");

    assert.match(describe, /if \(kids\.length === 0\)/, 'no names yet is not the same as none ticked');
    assert.match(describe, /Tick at least one child\. Photos are only saved for the children you tick\./);
    assert.match(describe, /st\.classList\.add\('err'\)/, 'marked, not merely written');
    assert.ok(html.includes('id="kids-status" role="status" aria-live="polite"'), 'beside the names, and announced');

    // Both paths into the empty state go through it: unticking the last child, and a list
    // that arrives with nothing included.
    assert.match(section(html, 'async function loadChildren()', 'function onChildToggled()'), /describeSelection\(\)/);
    assert.match(section(html, 'function onChildToggled()', 'function describeSelection()'), /describeSelection\(\)/);

    assert.ok(html.includes('none = kids.length > 0 && selectedIds().length === 0'), 'and Start stays disabled');
    assert.match(html, /Cannot start until at least one child is ticked/, 'with its own reason next to the button');
  } finally {
    await handle.close();
  }
});

test('the page offers Stop only while a run is going, and reports a stopped run as an ordinary end', async () => {
  await freshConfigDir();
  const { handle } = await setupUi({ connect: false });
  try {
    const html = await pageHtml(handle);
    assert.ok(
      html.includes('<button class="secondary" id="btn-stop" type="button" disabled>Stop</button>'),
      'Stop ships disabled, beside Start saving',
    );
    assert.match(html, /<div class="run-actions">/, 'and the two are spaced, not touching');
    assert.match(html, /stopBtn\.disabled = !isRunning \|\| stopping;/, 'enabled only while a run is going');

    const click = section(html, "$('btn-stop').onclick", 'function paint(p, running, result)');
    assert.match(click, /api\('\/api\/stop', \{ method: 'POST'/, 'posts to the endpoint through the token helper');
    assert.ok(!click.includes('fetch('), 'never a bare fetch, which would arrive without the token');

    const paint = html.slice(html.indexOf('function paint(p, running, result)'));
    assert.match(paint, /const stopped = p\.phase === 'stopped';/);
    assert.match(paint, /bar\.dataset\.stopped = stopped/, 'the bar holds still where the run stopped');
    assert.match(paint, /show\(\$\('run-result'\), 'ok', esc\(p\.message\)\)/, 'a neutral notice, not an error');
    assert.match(paint, /if \(p\.phase !== lastAnnounced\)/, 'and the new phase is announced once');
    assert.match(paint, /updateRunReady\(\);/, 'which is what puts Start back');
  } finally {
    await handle.close();
  }
});

// ---------------------------------------------------------------- test isolation

test('the isolation guard allows only a throwaway directory, not merely "not one of three"', async () => {
  const restore = process.env.CARE_ALBUM_CONFIG_DIR;
  const restoreScratch = process.env.CARE_ALBUM_TEST_SCRATCH;
  try {
    // Importing scripts/test-env.js fills the variable in only when it is unset, so a
    // stray value already naming the developer's own directory would sail straight
    // through it and this suite would write the mock's session over their real one.
    const refused = [
      // The three the guard used to know by name.
      join(homedir(), 'Library', 'Application Support', 'care-album-saver'),
      join(homedir(), '.config', 'care-album-saver'),
      join(homedir(), 'AppData', 'Roaming', 'care-album-saver'),
      // And the ones it did not, which is the point: anywhere in the home folder was
      // accepted as "isolated" purely because nobody had listed it.
      join(homedir(), 'care-album-saver'),
      join(homedir(), 'Developer', 'care-album-saver', 'config'),
      join(homedir(), 'Brightwheel Photos'),
      '/etc/care-album-saver',
      'relative/not-even-absolute',
    ];
    for (const dir of refused) {
      process.env.CARE_ALBUM_CONFIG_DIR = dir;
      assert.throws(
        assertIsolatedConfigDir,
        /not a throwaway test directory|not a full path/,
        `${dir} must be refused`,
      );
    }

    delete process.env.CARE_ALBUM_CONFIG_DIR;
    assert.throws(assertIsolatedConfigDir, /import scripts\/test-env\.js/);

    // What every test file actually does is accepted, or the guard is useless in the other
    // direction. mkdtemp's answer on a Mac is a symlinked spelling of the temp directory,
    // so this also pins that the comparison resolves both sides.
    const throwaway = await mkdtemp(join(tmpdir(), 'bw-guard-'));
    process.env.CARE_ALBUM_CONFIG_DIR = throwaway;
    assert.equal(assertIsolatedConfigDir(), throwaway);

    // The one escape hatch: somewhere outside the temp directory that its owner has said in
    // as many words is scratch space. It has to be said, and it only covers what it names.
    const elsewhere = join(homedir(), 'some-runner-scratch', 'bw-config');
    process.env.CARE_ALBUM_CONFIG_DIR = elsewhere;
    assert.throws(assertIsolatedConfigDir, /throwaway test directory/, 'unmarked, so refused');
    process.env.CARE_ALBUM_TEST_SCRATCH = join(homedir(), 'some-runner-scratch');
    assert.equal(assertIsolatedConfigDir(), elsewhere);
    process.env.CARE_ALBUM_CONFIG_DIR = join(homedir(), 'Library', 'x');
    assert.throws(assertIsolatedConfigDir, /throwaway test directory/, 'and covers only what it names');

    await rm(throwaway, { recursive: true, force: true });
  } finally {
    process.env.CARE_ALBUM_CONFIG_DIR = restore;
    if (restoreScratch === undefined) delete process.env.CARE_ALBUM_TEST_SCRATCH;
    else process.env.CARE_ALBUM_TEST_SCRATCH = restoreScratch;
  }
});
