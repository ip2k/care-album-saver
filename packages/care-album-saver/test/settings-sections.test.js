// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, configPath, startMockBrightwheel, startWebUi, writeSecureFile } from '../dist/index.js';

/**
 * What the review of the Settings sections (2026-09-23) found in the server's half: a folder
 * typed on the page resolved against the tool's own working directory; the page's facts kept
 * the folder from page load; and reconnecting after an expired session left the page stuck
 * in setup, because the failed run's line still said the session was refused.
 */

const SESSION = 'test-session-value';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

before(assertIsolatedConfigDir);

async function freshConfigDir() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-sections-'));
  delete process.env.CARE_ALBUM_SESSION;
  return assertIsolatedConfigDir();
}

async function ui(options) {
  const handle = await startWebUi(options);
  const call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-setup-token': handle.token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { handle, call };
}

test('a folder typed on the page must be a full path; the command line keeps relative ones', async () => {
  await freshConfigDir();
  const { handle, call } = await ui({});
  try {
    const relative = await call('/api/config', { archiveDir: 'Photos' });
    assert.equal(relative.status, 400);
    assert.equal(relative.body.field, 'archiveDir');
    assert.match(relative.body.error, /full path/);
    const dir = join(REPO_ROOT, 'node_modules', '.cache', `cas-sections-${Date.now()}`);
    const full = await call('/api/config', { archiveDir: dir });
    assert.equal(full.status, 200, JSON.stringify(full.body));
    // And the answer carries the folder as the page shows it, so its facts stay current.
    assert.ok(typeof full.body.archiveDirShown === 'string' && full.body.archiveDirShown.length > 0);
  } finally {
    await handle.close();
  }
});

test('reconnecting after the session was refused leaves setup, instead of staying stuck in it', async () => {
  await freshConfigDir();
  const archive = join(REPO_ROOT, 'node_modules', '.cache', `cas-sections-run-${Date.now()}`);
  await mkdir(archive, { recursive: true });
  await writeSecureFile(configPath(), JSON.stringify({ ...DEFAULT_CONFIG, archiveDir: archive, delayMs: 0 }));
  // One Brightwheel, one page: the mock reads forceExpired on every request, so the same
  // server can refuse the session for a run and then accept it again for the reconnect.
  const brightwheel = { validSession: SESSION };
  const mock = await startMockBrightwheel(brightwheel);
  const { handle, call } = await ui({ baseUrl: `${mock.url}/api/v1` });
  try {
    assert.equal((await call('/api/session', { cookie: SESSION })).status, 200);
    brightwheel.forceExpired = true;
    await call('/api/sync', {});
    let s;
    for (let i = 0; i < 200; i += 1) {
      s = (await call('/api/state')).body;
      if (!s.running) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(s.progress.phase, 'error');
    assert.match(s.progress.message, /session/, 'the page reads this line to go back to setup');

    brightwheel.forceExpired = false;
    assert.equal((await call('/api/session', { cookie: SESSION })).status, 200);
    const after = (await call('/api/state')).body;
    assert.notEqual(after.progress.phase, 'error', 'a fresh session ends the failed state');
    assert.doesNotMatch(after.progress.message, /session/);
    assert.equal(after.lastResult, null);
  } finally {
    await handle.close();
    await mock.close();
    await rm(archive, { recursive: true, force: true });
  }
});

test('while a run is going, the lock reaches the controls that moved to Save Locations', async () => {
  await freshConfigDir();
  const { handle } = await ui({});
  try {
    const page = await (await fetch(`http://127.0.0.1:${handle.port}/?token=${handle.token}`)).text();
    const lock = /const lockable = ([^;]+);/.exec(page)?.[1] ?? '';
    for (const piece of ['#card-children', '#dir-field', '#advanced-inner']) {
      assert.ok(lock.includes(piece), `the lock covers ${piece}`);
    }
  } finally {
    await handle.close();
  }
});
