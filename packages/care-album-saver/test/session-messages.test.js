// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, configPath, startMockBrightwheel, startWebUi, writeSecureFile } from '../dist/index.js';

/**
 * What the page says when Brightwheel refuses a session.
 *
 * It used to show the command line's own sentence — "Your Brightwheel session has expired.
 * Run `care-album-saver login` to sign in again." — to a parent in a browser, who has no
 * command to run, about a value that may never have been valid at all: a paste into the demo,
 * from the wrong row, or cut short, is refused exactly as an expired one is.
 */

const SESSION = 'test-session-value';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

before(assertIsolatedConfigDir);

async function freshConfigDir() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-refused-'));
  delete process.env.CARE_ALBUM_SESSION;
  return assertIsolatedConfigDir();
}

const call = async (handle, path, body) => {
  const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-setup-token': handle.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

test('a pasted value Brightwheel refuses is explained for a browser, without claiming it expired', async () => {
  await freshConfigDir();
  const mock = await startMockBrightwheel({ validSession: SESSION });
  const handle = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  try {
    const refused = await call(handle, '/api/session', { cookie: 'a-perfectly-shaped-value-that-is-not-the-session-at-all' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Brightwheel did not accept that value/);
    assert.match(refused.body.error, /_brightwheel_v2/, 'it says where the right value lives');
    assert.doesNotMatch(refused.body.error, /care-album-saver login|expired/i, 'no terminal command, no guessed cause');
  } finally {
    await handle.close();
    await mock.close();
  }
});

test('a run whose session stops working says so for a browser, and still sends the page back to step 1', async () => {
  await freshConfigDir();
  // me, students and the first listing succeed; the next request finds the session gone.
  const mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 23, maxPageSize: 10, expireSessionAfterRequests: 3 });
  const archive = join(REPO_ROOT, 'node_modules', '.cache', `cas-refused-${Date.now()}`);
  await mkdir(archive, { recursive: true });
  await writeSecureFile(configPath(), JSON.stringify({ ...DEFAULT_CONFIG, archiveDir: archive, delayMs: 0, incremental: false }));
  const handle = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  try {
    assert.equal((await call(handle, '/api/session', { cookie: SESSION })).status, 200);
    assert.equal((await call(handle, '/api/sync', {})).status, 202);
    let state;
    for (let i = 0; i < 200; i += 1) {
      state = (await call(handle, '/api/state')).body;
      if (!state.running) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(state.progress.phase, 'error');
    assert.match(state.progress.message, /Brightwheel no longer accepts the saved session/);
    assert.doesNotMatch(state.progress.message, /care-album-saver login/);
    // The page decides to show the setup steps again by looking for "session" in this line.
    assert.match(state.progress.message, /session/);
  } finally {
    await handle.close();
    await mock.close();
    await rm(archive, { recursive: true, force: true });
  }
});
