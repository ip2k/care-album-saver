// First, before anything that can read the config directory: points this file at a
// throwaway one even when it is run on its own with `node --test`, which applies no
// --import (see scripts/test-env.js).
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startMockBrightwheel, startWebUi, writeSecureFile } from '../dist/index.js';

/**
 * Choosing which children to archive, and the rule that what the page shows is what runs.
 *
 * Everything here goes through the real setup UI over HTTP, against the mock. The two
 * children are the mock's invented Robin and Sam Maple.
 */

let mock;
const SESSION = 'test-session-value';
const ROBIN = 'stu-aaa-111';
const SAM = 'stu-bbb-222';

before(assertIsolatedConfigDir);
before(async () => { mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 4 }); });
after(async () => { await mock?.close(); });

/** A connected setup UI plus a tiny client that speaks to it the way the page does. */
async function connectedUi() {
  const ui = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  const call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${ui.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-setup-token': ui.token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const session = await call('/api/session', { cookie: SESSION });
  assert.equal(session.status, 200, 'connecting to the mock must work');
  return { ui, call, close: () => ui.close() };
}

// ---------------------------------------------------------------- which children

test('/api/children reports every child as included until a choice is made', async () => {
  const { call, close } = await connectedUi();
  try {
    const { status, body } = await call('/api/children');
    assert.equal(status, 200);
    assert.deepEqual(body.children.map((c) => c.fullName), ['Robin Maple', 'Sam Maple']);
    // The stored default is [] ("all"); the page needs the resolved ids to tick the boxes.
    assert.deepEqual(body.included, [ROBIN, SAM]);
  } finally {
    await close();
  }
});

test('a child selection round-trips through /api/config, /api/state and /api/children', async () => {
  const { call, close } = await connectedUi();
  try {
    const saved = await call('/api/config', { includeStudents: [ROBIN] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.config.includeStudents, [ROBIN]);

    const state = await call('/api/state');
    assert.deepEqual(state.body.config.includeStudents, [ROBIN], 'persisted to disk');

    const children = await call('/api/children');
    assert.deepEqual(children.body.included, [ROBIN], 'reload renders the same ticks');
    assert.equal(children.body.children.length, 2, 'the unticked child is still listed');
  } finally {
    await close();
  }
});

test('ticking every child is stored as "all", so a child added later is not left out', async () => {
  const { call, close } = await connectedUi();
  try {
    await call('/api/config', { includeStudents: [SAM] });
    const saved = await call('/api/config', { includeStudents: [SAM, ROBIN] });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.config.includeStudents, [], 'the full set collapses to []');
    const children = await call('/api/children');
    assert.deepEqual(children.body.included, [ROBIN, SAM]);
  } finally {
    await close();
  }
});

test('a selection with nobody in it is refused in plain language and nothing is stored', async () => {
  const { call, close } = await connectedUi();
  try {
    await call('/api/config', { includeStudents: [ROBIN] });
    const refused = await call('/api/config', { includeStudents: [] });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.ok, false);
    assert.equal(refused.body.field, 'includeStudents', 'the page needs to know which control to mark');
    assert.match(refused.body.error, /tick at least one child/i);
    assert.doesNotMatch(refused.body.error, /includeStudents|array|null/i, 'no developer words');

    const state = await call('/api/state');
    assert.deepEqual(state.body.config.includeStudents, [ROBIN], 'the previous choice survives');
  } finally {
    await close();
  }
});

test('a child who is not on the account cannot be selected', async () => {
  const { call, close } = await connectedUi();
  try {
    // Every test in this file shares one config directory, so start from a known choice.
    await call('/api/config', { includeStudents: [SAM] });
    for (const bad of [['stu-not-here'], [ROBIN, 'stu-not-here'], ['', ROBIN], 'stu-aaa-111', [42]]) {
      const refused = await call('/api/config', { includeStudents: bad });
      assert.equal(refused.status, 400, `${JSON.stringify(bad)} should be refused`);
      assert.equal(refused.body.field, 'includeStudents');
    }
    const state = await call('/api/state');
    assert.deepEqual(state.body.config.includeStudents, [SAM], 'the choice survives every refusal');
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------- what you see is what runs

test('settings that save themselves in quick succession are all kept', async () => {
  // Every control now saves on change, so several small patches can be in flight at once.
  // Each is a read-modify-write of the same file; without serialisation the last one to
  // read wins and quietly drops the others.
  const { call, close } = await connectedUi();
  try {
    const patches = [
      { tagChildName: false },
      { tagNote: false },
      { stripLocation: false },
      { organiseBy: 'week' },
      { includeStudents: [SAM] },
      { writeSidecar: true },
    ];
    const results = await Promise.all(patches.map((p) => call('/api/config', p)));
    for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));

    const { config } = (await call('/api/state')).body;
    assert.equal(config.tagChildName, false);
    assert.equal(config.tagNote, false);
    assert.equal(config.stripLocation, false);
    assert.equal(config.organiseBy, 'week');
    assert.equal(config.writeSidecar, true);
    assert.deepEqual(config.includeStudents, [SAM]);
  } finally {
    await close();
  }
});

test('the page saves each option as it changes and persists the form before starting', async () => {
  const ui = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  try {
    const html = await (await fetch(`http://127.0.0.1:${ui.port}/?token=${ui.token}`)).text();

    // The bug this guards against: untick "label with name", press Start, and the name is
    // written anyway because the run reads settings from disk and the tick was never saved.
    for (const id of ['tagChildName', 'tagNote', 'stripLocation', 'incremental', 'writeSidecar']) {
      assert.ok(html.includes(`id="${id}"`), `#${id} exists`);
    }
    assert.match(html, /\$\(k\)\.addEventListener\('change', \(\) => persist\(\{ \[k\]: \$\(k\)\.checked \}\)\)/, 'every tick saves itself');
    assert.match(html, /\$\('organiseBy'\)\.addEventListener\('change'/, 'the layout menu saves itself');
    assert.match(html, /\$\('archiveDir'\)\.addEventListener\('change'/, 'the folder saves when the field is left');
    assert.ok(!html.includes('Save settings'), 'no separate save button for the ticks to be forgotten behind');

    const run = html.slice(html.indexOf("$('btn-run').onclick"));
    const persistAt = run.indexOf('persist(formState()');
    const syncAt = run.indexOf("'/api/sync'");
    assert.ok(persistAt > 0 && syncAt > persistAt, 'Start saving persists the whole form before it starts');
    assert.ok(run.slice(persistAt, syncAt).includes('return;'), 'and refuses to start when that fails');

    // The child chips are real checkboxes with real labels, and names are escaped.
    assert.ok(html.includes('<fieldset class="kids-set">'), 'children are grouped as a fieldset');
    assert.ok(html.includes('<legend>Save photos for</legend>'));
    assert.ok(html.includes("<label class=\"kid\" for=\"kid-' + i + '\">"), 'label[for] per child');
    assert.ok(html.includes("'<input type=\"checkbox\" id=\"kid-' + i + '\" data-id=\"' + esc(k.id) + '\"'"), 'checkbox per child, id escaped');
    assert.ok(html.includes('esc(k.fullName)'), 'the name is escaped before innerHTML');
    assert.ok(html.includes('id="kids-status" role="status" aria-live="polite"'), 'selection changes are announced');
    assert.match(html, /\.kid input\[type=checkbox\][^}]*width: 1\.5rem; height: 1\.5rem/, 'checkbox is 24px');
    assert.ok(html.includes('none = kids.length > 0 && selectedIds().length === 0'), 'Start is disabled when nobody is ticked');
    assert.match(html, /forced-colors: active[^}]*\.kid/, 'chips keep a border in forced-colours mode');
  } finally {
    await ui.close();
  }
});

// ---------------------------------------------------------------- command line

/** Run the real CLI in a child process with its own throwaway config directory. */
async function cli(args, configDir) {
  const bin = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [bin, ...args, '--base-url', `${mock.url}/api/v1`], {
      env: { ...process.env, CARE_ALBUM_CONFIG_DIR: configDir },
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '' };
  }
}

async function signedInConfigDir() {
  const dir = await mkdtemp(join(tmpdir(), 'bw-cli-'));
  await writeSecureFile(join(dir, 'session.json'), JSON.stringify({ cookie: SESSION, savedAt: new Date().toISOString() }));
  return dir;
}

test('`children` prints each id next to the name, so --child has something to copy', async () => {
  const dir = await signedInConfigDir();
  const { code, stdout } = await cli(['children'], dir);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /Robin Maple\s+id: stu-aaa-111/);
  assert.match(stdout, /Sam Maple\s+id: stu-bbb-222/);
  assert.match(stdout, /--child/, 'tells the person what the id is for');
});

test('`run --child` filters that run only and does not touch the saved settings', async () => {
  const dir = await signedInConfigDir();
  // The archive lands in a temporary folder, which the run refuses — after the filter has
  // been resolved and announced, which is the part under test here. Where photos may go is
  // sync's business and is covered elsewhere.
  const scratch = await mkdtemp(join(tmpdir(), 'bw-cli-photos-'));
  const byName = await cli(['run', '--child', 'sam maple', '--dir', scratch], dir);
  assert.match(byName.stdout, /Only: Sam Maple/, 'matched case-insensitively by full name');
  assert.doesNotMatch(byName.stdout, /Only:.*Robin/);

  const byId = await cli(['run', '--child', ROBIN, '--child', SAM, '--dir', scratch], dir);
  assert.match(byId.stdout, /Only: Robin Maple, Sam Maple/, 'repeatable, matched by id');

  const state = await cli(['where'], dir);
  assert.equal(state.code, 0);
  const { stdout } = await cli(['children'], dir);
  assert.match(stdout, /Robin Maple/, 'still signed in');
  // Nothing was written back: `run` never saves settings, so there is no config file at all.
  const { readdir } = await import('node:fs/promises');
  assert.ok(!(await readdir(dir)).includes('config.json'), '--child must not persist');
});

test('`run --child` with a name that is not on the account stops before doing anything', async () => {
  const dir = await signedInConfigDir();
  // --dir, so that a regression in the unknown-child guard fails safe: sync refuses a
  // temporary folder, where without it the run would fall back to the stored default and
  // archive into the developer's own ~/Brightwheel Photos.
  const scratch = await mkdtemp(join(tmpdir(), 'bw-cli-photos-'));
  const { code, stdout } = await cli(['run', '--child', 'Nobody Here', '--dir', scratch], dir);
  assert.equal(code, 1);
  assert.match(stdout, /No child called "Nobody Here"/);
  assert.match(stdout, /care-album-saver children/, 'points at the command that lists them');
  assert.doesNotMatch(stdout, /Looking for/, 'no run started');
});
