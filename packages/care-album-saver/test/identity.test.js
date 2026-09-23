// First, before anything that can read the config directory: the session file lives there.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DEFAULT_CONFIG,
  Secret,
  acceptableUserAgent,
  browserUserAgent,
  chromeMajor,
  configPath,
  loadSession,
  sessionPath,
  startMockBrightwheel,
  startWebUi,
  verify,
  writeSecureFile,
} from '../dist/index.js';

/**
 * What the tool calls itself when it talks to Brightwheel: nothing of its own.
 *
 * Every request — API and media, from the page, the command line and `verify` — carries a
 * browser's identity: the one the session was pasted from when the setup page saw it, and an
 * ordinary desktop Chrome when it did not. These tests read the identity off the mock's own
 * request log, so they check what actually went over the wire rather than what the code meant.
 */

const SESSION = 'test-session-value';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0';
const EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';

let mock;
before(assertIsolatedConfigDir);
before(async () => { mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 3 }); });
after(async () => { await mock?.close(); });

async function freshConfigDir() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-identity-'));
  delete process.env.CARE_ALBUM_SESSION;
  return assertIsolatedConfigDir();
}

/** An archive the destination rules accept: temp folders are refused by design. */
async function archiveDir() {
  const dir = join(REPO_ROOT, 'node_modules', '.cache', `cas-identity-${Math.random().toString(16).slice(2, 10)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

const since = (n) => mock.requests.slice(n);

// ---------------------------------------------------------------- the stand-in

test('the stand-in is a stock desktop Chrome, with nothing of this tool in it', () => {
  const now = new Date('2026-09-23T12:00:00Z');
  assert.equal(
    browserUserAgent(now, 'darwin'),
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  );
  assert.match(browserUserAgent(now, 'win32'), /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) .* Chrome\/153\.0\.0\.0 Safari\/537\.36$/);
  assert.match(browserUserAgent(now, 'linux'), /^Mozilla\/5\.0 \(X11; Linux x86_64\) .* Chrome\/153\.0\.0\.0 Safari\/537\.36$/);
  for (const platform of ['darwin', 'win32', 'linux']) {
    const ua = browserUserAgent(now, platform);
    assert.ok(!/care|album|saver|node|github/i.test(ua), ua);
    assert.equal(acceptableUserAgent(ua), ua, 'and it passes the same test a captured one must');
  }
});

test('its Chrome version keeps pace with the calendar, and never runs ahead of stable', () => {
  // 153 was the stable Chrome on the development Mac on this date.
  assert.equal(chromeMajor(new Date('2026-09-23')), 153);
  let previous = 0;
  for (let month = 0; month < 60; month += 1) {
    const version = chromeMajor(new Date(Date.UTC(2026, 8 + month, 15)));
    assert.ok(version >= previous, 'never goes backwards');
    previous = version;
  }
  // Chrome ships 12 or 13 versions a year; the estimate must not claim more than that.
  const inAYear = chromeMajor(new Date('2027-09-23')) - chromeMajor(new Date('2026-09-23'));
  assert.ok(inAYear >= 11 && inAYear <= 13, `${inAYear} versions in a year`);
  // A clock set in the past does not produce an antique.
  assert.equal(chromeMajor(new Date('2020-01-01')), 153);
});

// ---------------------------------------------------------------- what may be captured

test('a browser identity from the setup page is kept; anything else is not', () => {
  for (const ua of [SAFARI, FIREFOX, EDGE, browserUserAgent()]) assert.equal(acceptableUserAgent(ua), ua);
  for (const bad of [
    'node',
    'undici',
    'curl/8.7.1',
    'python-requests/2.32',
    '',
    undefined,
    ['Mozilla/5.0 (X11)'],
    `${SAFARI}\r\nX-Injected: yes`,
    'Mozilla/5.0 (Macintosh) Safari é',
    `Mozilla/5.0 (X11) ${'a'.repeat(600)}`,
  ]) {
    assert.equal(acceptableUserAgent(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('a hand-edited session file cannot put anything but a browser identity on the wire', async () => {
  await freshConfigDir();
  await writeSecureFile(
    sessionPath(),
    JSON.stringify({ cookie: SESSION, savedAt: new Date().toISOString(), userAgent: 'evil\r\nX-Injected: yes' }),
  );
  assert.equal((await loadSession()).userAgent, null);
});

// ---------------------------------------------------------------- over the wire

test('connecting from the setup page keeps that browser identity, and every request carries it', async () => {
  await freshConfigDir();
  const dir = await archiveDir();
  await writeSecureFile(configPath(), JSON.stringify({ ...DEFAULT_CONFIG, archiveDir: dir, delayMs: 0 }));
  const handle = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  const start = mock.requests.length;
  try {
    const call = (path, body) =>
      fetch(`http://127.0.0.1:${handle.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-setup-token': handle.token, 'user-agent': SAFARI },
        body: JSON.stringify(body),
      });
    assert.equal((await call('/api/session', { cookie: SESSION })).status, 200);
    assert.equal(JSON.parse(await readFile(sessionPath(), 'utf8')).userAgent, SAFARI, 'kept with the session');
    assert.equal((await call('/api/sync', {})).status, 202);
    for (let i = 0; i < 200 && !(await state(handle)).lastResult; i += 1) await new Promise((r) => setTimeout(r, 50));

    const seen = since(start);
    assert.ok(seen.some((r) => r.path.startsWith('/media/')), 'photos were fetched');
    assert.ok(seen.some((r) => !r.path.startsWith('/media/')), 'and the API was called');
    for (const r of seen) assert.equal(r.userAgent, SAFARI, `${r.path} went out as ${r.userAgent}`);
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('with no browser identity to keep, requests go out as a stock Chrome — never as node', async () => {
  await freshConfigDir();
  const handle = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  const start = mock.requests.length;
  try {
    // Node's own fetch, as a script calling the setup API would: its identity is not kept.
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-setup-token': handle.token },
      body: JSON.stringify({ cookie: SESSION }),
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(await readFile(sessionPath(), 'utf8')).userAgent, null);
    const seen = since(start);
    assert.ok(seen.length > 0);
    for (const r of seen) assert.equal(r.userAgent, browserUserAgent());
  } finally {
    await handle.close();
  }
});

test('the command line sends the kept identity, or the stock one — on the API and the photos', async () => {
  const dir = await archiveDir();
  try {
    for (const kept of [SAFARI, null]) {
      const configDir = await mkdtemp(join(tmpdir(), 'cas-identity-cli-'));
      await writeSecureFile(
        join(configDir, 'session.json'),
        JSON.stringify({ cookie: SESSION, savedAt: new Date().toISOString(), userAgent: kept }),
      );
      await writeSecureFile(
        join(configDir, 'config.json'),
        JSON.stringify({ ...DEFAULT_CONFIG, archiveDir: dir, delayMs: 0, incremental: false }),
      );
      const start = mock.requests.length;
      await promisify(execFile)(process.execPath, [CLI, 'run', '--base-url', `${mock.url}/api/v1`], {
        env: { ...process.env, CARE_ALBUM_CONFIG_DIR: configDir },
      }).catch((e) => e);
      const seen = since(start);
      assert.ok(seen.length > 0, 'the run reached the mock');
      for (const r of seen) assert.equal(r.userAgent, kept ?? browserUserAgent(), `${r.path}`);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verify sends the same identity on every request it makes', async () => {
  const start = mock.requests.length;
  await verify(new Secret(SESSION), { baseUrl: `${mock.url}/api/v1`, userAgent: FIREFOX });
  const seen = since(start);
  assert.ok(seen.length > 0);
  for (const r of seen) assert.equal(r.userAgent, FIREFOX, r.path);

  const next = mock.requests.length;
  await verify(new Secret(SESSION), { baseUrl: `${mock.url}/api/v1` });
  for (const r of since(next)) assert.equal(r.userAgent, browserUserAgent(), 'never `node`');
});

test('no source file names this tool in a header', async () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const offenders = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.ts')) {
        const code = (await readFile(full, 'utf8'))
          .split('\n')
          .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
          .join('\n');
        if (/['"`]User-Agent['"`]\s*:\s*['"`]/i.test(code)) offenders.push(full);
      }
    }
  };
  await walk(root);
  assert.deepEqual(offenders, [], 'a literal User-Agent value is a fixed identity; it must come from api/identity.ts');
});

async function state(handle) {
  const res = await fetch(`http://127.0.0.1:${handle.port}/api/state`, { headers: { 'x-setup-token': handle.token } });
  return res.json();
}
