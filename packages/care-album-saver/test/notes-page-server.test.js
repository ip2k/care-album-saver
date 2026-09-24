// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { DEFAULT_CONFIG, configPath, startMockBrightwheel, startWebUi, writeSecureFile } from '../dist/index.js';
import { hostAllowed } from '../dist/web/server.js';
import { PAGE } from '../dist/web/page.js';

/**
 * The security review's NOTEs for the setup server (docs/SECURITY-REVIEW-2026-09-23.md §4.3):
 * where the setup token may travel (Q10, from web-7 and page-8), the port in the Host and
 * Origin checks (web-10), and the field that sends the page back to step 1 in place of words
 * (the page verifier's needsSetup note). Checked against the real server over HTTP; the
 * page's side of each is run in node:vm, as page-warnings.test.js does.
 */

before(assertIsolatedConfigDir);

const SESSION = 'test-session-value';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

let mock;
before(async () => { mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 2 }); });
after(async () => { await mock?.close(); });

async function freshConfigDir() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-notes-page-server-'));
  delete process.env.CARE_ALBUM_SESSION;
  return assertIsolatedConfigDir();
}

async function withUi(work) {
  await freshConfigDir();
  const ui = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  try {
    return await work(ui);
  } finally {
    await ui.close();
  }
}

/** One request with exactly these headers: fetch will not set Host, and fills in others. */
function raw(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const TAG = '<script nonce="__NONCE__">';
const SCRIPT = PAGE.slice(PAGE.indexOf(TAG) + TAG.length, PAGE.indexOf('</script>'));

function slice(from, to) {
  const a = SCRIPT.indexOf(from);
  const b = SCRIPT.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `expected the page script to contain ${from} ... ${to}`);
  return SCRIPT.slice(a, b);
}

// ------------------------------------------------------------------ Q10 (web-7, page-8)

test('Q10: /api/* takes the token from the header only, and refuses it in the address', async () => {
  await withUi(async (ui) => {
    const at = `http://127.0.0.1:${ui.port}`;
    const header = { 'x-setup-token': ui.token };

    assert.equal((await fetch(`${at}/api/state`, { headers: header })).status, 200, 'the header is enough');
    const inAddress = await fetch(`${at}/api/state?token=${ui.token}`);
    assert.equal(inAddress.status, 403, 'the address alone is refused on /api/*');
    assert.match(await inAddress.text(), /Wrong or missing setup link/, 'as a request with no token is');

    // A POST too, and one that would change something: nothing is written.
    const post = await fetch(`${at}/api/config?token=${ui.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tagNote: false }),
    });
    assert.equal(post.status, 403);
    const state = await (await fetch(`${at}/api/state`, { headers: header })).json();
    assert.equal(state.config.tagNote, true, 'the refused change was not stored');

    // Both at once: the header decides, whatever the address says.
    const wrongHeader = await fetch(`${at}/api/state?token=${ui.token}`, { headers: { 'x-setup-token': 'not-the-token' } });
    assert.equal(wrongHeader.status, 403, 'a wrong header is not rescued by a right address');
    assert.equal((await fetch(`${at}/api/state?token=wrong`, { headers: header })).status, 200, 'a right header is not spoiled by the address');
  });
});

test('Q10: the page itself and /photo still take the token from the address, where no header can be sent', async () => {
  await withUi(async (ui) => {
    const at = `http://127.0.0.1:${ui.port}`;
    // The link the terminal prints.
    assert.equal((await fetch(`${at}/?token=${ui.token}`)).status, 200);
    assert.equal((await fetch(`${at}/`)).status, 403);
    // /photo from an <img>: past the token check to the route itself, which has nothing at 0.
    const photo = await fetch(`${at}/photo?i=0&token=${ui.token}`);
    assert.equal(photo.status, 404);
    assert.equal(await photo.text(), 'Not found', 'the route answered, not the token check');
    assert.equal((await fetch(`${at}/photo?i=0`)).status, 403, 'and without it, nothing');
    // Here too a header, when there is one, is what counts.
    assert.equal((await fetch(`${at}/photo?i=0&token=${ui.token}`, { headers: { 'x-setup-token': 'nope' } })).status, 403);
    assert.equal((await fetch(`${at}/?token=${ui.token}`, { headers: { 'x-setup-token': 'nope' } })).status, 403);
  });
});

test('Q10: the page puts the token in the address of /photo and of nothing else', async () => {
  // Behaviour, not only text: api() run against a stand-in fetch.
  const seen = [];
  const context = createContext({
    TOKEN: 'the-token',
    fetch: (url, init) => { seen.push({ url, init }); return Promise.resolve(null); },
  });
  runInContext(slice('const api = ', '\n/**'), context);
  runInContext("api('/api/state'); api('/api/gallery?page=2'); api('/api/config', { method: 'POST', body: '{}' })", context);
  assert.deepEqual(seen.map((s) => s.url), ['/api/state', '/api/gallery?page=2', '/api/config'], 'the address is the path, as given');
  for (const s of seen) assert.equal(s.init.headers['x-setup-token'], 'the-token', `${s.url} carries it in the header`);
  assert.equal(seen[2].init.method, 'POST', 'and the rest of what was asked goes through untouched');

  // The one place the script writes the token into an address is photoHref, for <img> and <video>.
  const inAddresses = [...SCRIPT.matchAll(/token=/g)].map((m) => SCRIPT.slice(SCRIPT.lastIndexOf('\n', m.index) + 1, SCRIPT.indexOf('\n', m.index)));
  assert.deepEqual(inAddresses, ["const photoHref = (item) => '/photo?i=' + item.id + '&token=' + TOKEN;"]);
});

// ------------------------------------------------------------------ web-10

test('web-10: the Host header must name this server\'s own port, not merely a loopback name', async () => {
  await withUi(async (ui) => {
    const page = `/?token=${ui.token}`;
    const other = ui.port === 65535 ? ui.port - 1 : ui.port + 1;
    assert.equal((await raw(ui.port, page, { Host: `127.0.0.1:${ui.port}` })).status, 200);
    assert.equal((await raw(ui.port, page, { Host: `localhost:${ui.port}` })).status, 200, 'either loopback name');
    assert.equal((await raw(ui.port, page, { Host: `127.0.0.1:${other}` })).status, 403, 'another port is another site');
    assert.equal((await raw(ui.port, page, { Host: `localhost:${other}` })).status, 403);
    assert.equal((await raw(ui.port, page, { Host: '127.0.0.1' })).status, 403, 'no port means 80, which this is not');
    assert.equal((await raw(ui.port, page, { Host: `127.0.0.1:${ui.port}:${ui.port}` })).status, 403);
    assert.equal((await raw(ui.port, page, { Host: `evil.example:${ui.port}` })).status, 403);
  });
});

test('web-10: an Origin must be this server exactly: http, a loopback name, and this port', async () => {
  await withUi(async (ui) => {
    const other = ui.port === 65535 ? ui.port - 1 : ui.port + 1;
    const state = (origin) =>
      fetch(`http://127.0.0.1:${ui.port}/api/state`, { headers: { 'x-setup-token': ui.token, origin } }).then((r) => r.status);
    assert.equal(await state(`http://127.0.0.1:${ui.port}`), 200);
    assert.equal(await state(`http://localhost:${ui.port}`), 200);
    // Another program's page on this computer — a development server, say.
    assert.equal(await state(`http://127.0.0.1:${other}`), 403, 'another port');
    assert.equal(await state(`http://localhost:${other}`), 403);
    assert.equal(await state('http://127.0.0.1'), 403, 'port 80');
    assert.equal(await state(`https://127.0.0.1:${ui.port}`), 403, 'another scheme');
    assert.equal(await state('null'), 403, 'an opaque origin');
  });
});

test('web-10: hostAllowed, case by case', () => {
  assert.equal(hostAllowed('127.0.0.1:4000', 4000), true);
  assert.equal(hostAllowed('localhost:4000', 4000), true);
  assert.equal(hostAllowed('127.0.0.1', 80), true, 'no port is port 80');
  assert.equal(hostAllowed('127.0.0.1:80', 80), true);
  assert.equal(hostAllowed('127.0.0.1:4001', 4000), false);
  assert.equal(hostAllowed('127.0.0.1', 4000), false);
  assert.equal(hostAllowed('127.0.0.1:', 4000), false);
  assert.equal(hostAllowed('user@127.0.0.1:4000', 4000), false);
  assert.equal(hostAllowed('127.0.0.2:4000', 4000), false);
  assert.equal(hostAllowed('[::1]:4000', 4000), false, 'the server listens on 127.0.0.1 only');
  assert.equal(hostAllowed(undefined, 4000), false);
  assert.equal(hostAllowed('', 4000), false);
});

test('web-10: a legitimate page on another port of this machine cannot drive the tool, even with no fetch metadata', async () => {
  // The shape web-10 is about: a browser (or an older one without Sec-Fetch-Site) sending a
  // request from a page on localhost:OTHER. Only Origin says where it came from.
  const neighbour = createServer((req, res) => res.end('another program'));
  await new Promise((r) => neighbour.listen(0, '127.0.0.1', r));
  const other = neighbour.address().port;
  try {
    await withUi(async (ui) => {
      const res = await fetch(`http://127.0.0.1:${ui.port}/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-setup-token': ui.token, origin: `http://localhost:${other}` },
        body: JSON.stringify({ tagNote: false }),
      });
      assert.equal(res.status, 403);
      assert.equal(await res.text(), 'Blocked: cross-site request.');
      const state = await (await fetch(`http://127.0.0.1:${ui.port}/api/state`, { headers: { 'x-setup-token': ui.token } })).json();
      assert.equal(state.config.tagNote, true, 'and nothing was changed');
    });
  } finally {
    await new Promise((r) => neighbour.close(r));
  }
});

// ------------------------------------------------------------------ needsSetup by a field

const call = async (ui, path, body) => {
  const res = await fetch(`http://127.0.0.1:${ui.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-setup-token': ui.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

async function runToTheEnd(ui) {
  assert.equal((await call(ui, '/api/sync', {})).status, 202);
  let state;
  for (let i = 0; i < 200; i += 1) {
    state = (await call(ui, '/api/state')).body;
    if (!state.running) return state;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail('the run did not end');
}

test('needsSetup: a run Brightwheel refused for its session is marked reason "session"; any other failure is not', async () => {
  await freshConfigDir();
  const expiring = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 23, maxPageSize: 10, expireSessionAfterRequests: 3 });
  const archive = join(REPO_ROOT, 'node_modules', '.cache', `cas-notes-page-server-${Date.now()}`);
  await mkdir(archive, { recursive: true });
  await writeSecureFile(configPath(), JSON.stringify({ ...DEFAULT_CONFIG, archiveDir: archive, delayMs: 0, incremental: false }));
  const ui = await startWebUi({ baseUrl: `${expiring.url}/api/v1` });
  try {
    assert.equal((await call(ui, '/api/session', { cookie: SESSION })).status, 200);
    const refused = await runToTheEnd(ui);
    assert.equal(refused.progress.phase, 'error');
    assert.equal(refused.progress.reason, 'session', 'the field the page reads');
  } finally {
    await ui.close();
    await expiring.close();
    await rm(archive, { recursive: true, force: true });
  }

  // A run that fails for another reason: the folder is a temporary one, which a run refuses.
  await withUi(async (other) => {
    assert.equal((await call(other, '/api/session', { cookie: SESSION })).status, 200);
    await writeSecureFile(configPath(), JSON.stringify({ ...DEFAULT_CONFIG, archiveDir: join(tmpdir(), 'cas-notes-refused'), delayMs: 0 }));
    const failed = await runToTheEnd(other);
    assert.equal(failed.progress.phase, 'error');
    assert.equal(failed.progress.reason, undefined, 'not a session failure, so not marked as one');
  });
});

test('needsSetup: the page goes back to step 1 on the field, and no longer on words in the message', () => {
  const context = createContext({});
  runInContext(slice('function needsSetup(s)', '\n}\n') + '\n}', context);
  const needs = (s) => runInContext(`needsSetup(${JSON.stringify(s)})`, context);
  const archive = { totalFiles: 12 };
  assert.equal(needs({ hasSession: true, archive, progress: { phase: 'error', reason: 'session', message: 'Brightwheel no longer accepts the saved session.' } }), true);
  // The message is scrubbed error text, in English, from anywhere: words in it decide nothing.
  for (const message of ['The session folder could not be written.', 'Please sign in again', 'The disk is full; the session expired meanwhile']) {
    assert.equal(needs({ hasSession: true, archive, progress: { phase: 'error', message } }), false, message);
  }
  assert.equal(needs({ hasSession: true, archive, progress: { phase: 'done', reason: 'session', message: 'Saved 3' } }), false, 'only a failed run');
  assert.equal(needs({ hasSession: false, archive }), true, 'no session is still setup');
  assert.equal(needs({ hasSession: true, sessionRejected: true, archive }), true, 'nor one refused on load');
  assert.equal(needs({ hasSession: true, archive: { totalFiles: 0 } }), true, 'nor an empty archive');
  assert.equal(needs({ hasSession: true, archive }), false);
  assert.doesNotMatch(slice('function needsSetup(s)', '\n}\n'), /\.test\(/, 'no pattern is matched against any text');
});
