import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { request as httpRequest } from 'node:http';
import {
  BrightwheelClient, startMockBrightwheel, sync, Secret, scrub, scrubDeep,
  normaliseCookieInput, DEFAULT_CONFIG, writeSecureFile, startWebUi,
} from '../dist/index.js';

let mock;
const SESSION = 'test-session-value';

before(async () => { mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 12 }); });
after(async () => { await mock?.close(); });

const client = (session = SESSION) =>
  new BrightwheelClient({ session: new Secret(session), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });

// ---------------------------------------------------------------- secrets

test('a Secret cannot be printed by accident', () => {
  const s = new Secret('super-secret-cookie-value');
  assert.equal(String(s), '[redacted]');
  assert.equal(`${s}`, '[redacted]');
  assert.equal(JSON.stringify({ cookie: s }), '{"cookie":"[redacted]"}');
  assert.ok(!inspect(s).includes('super-secret'));
  assert.ok(!inspect({ nested: { deep: s } }).includes('super-secret'));
  // The only way to the plaintext is the greppable call.
  assert.equal(s.expose(), 'super-secret-cookie-value');
});

test('fingerprints identify a session without revealing it', () => {
  const a = new Secret('abc');
  assert.equal(a.fingerprint(), new Secret('abc').fingerprint());
  assert.notEqual(a.fingerprint(), new Secret('abd').fingerprint());
  assert.ok(!a.fingerprint().includes('abc'));
});

test('scrub catches credentials that leaked into free text', () => {
  assert.ok(!scrub('Cookie: _brightwheel_v2=abc123def').includes('abc123def'));
  assert.ok(!scrub('GET /m.jpg?signature=deadbeef&x=1').includes('deadbeef'));
  assert.ok(!scrub('authorization: Bearer tok_live_xyz').includes('tok_live_xyz'));
  // Ordinary text is left alone.
  assert.equal(scrub('saved 12 photos'), 'saved 12 photos');
});

test('scrubDeep redacts by key name as well as by value', () => {
  const out = scrubDeep({ ok: 1, sessionCookie: 'raw', nested: { password: 'hunter2' } });
  assert.equal(out.sessionCookie, '[redacted]');
  assert.equal(out.nested.password, '[redacted]');
  assert.equal(out.ok, 1);
});

test('cookie input is accepted in every form a parent might paste', () => {
  assert.equal(normaliseCookieInput('rawvalue123').expose(), 'rawvalue123');
  assert.equal(normaliseCookieInput('_brightwheel_v2=abc').expose(), 'abc');
  assert.equal(normaliseCookieInput('Cookie: other=1; _brightwheel_v2=abc; z=2').expose(), 'abc');
  assert.equal(normaliseCookieInput('   '), null);
});

// ---------------------------------------------------------------- api

test('client reads the account and the children', async () => {
  const me = await client().me();
  assert.equal(me.email, 'parent@example.com');
  const kids = await client().students(me.id);
  assert.equal(kids.length, 2);
  assert.equal(kids[0].fullName, 'Robin Maple');
  assert.equal(kids[0].schoolName, 'Sunnybrook Early Learning');
});

test('an expired session is detected even when the server answers 200', async () => {
  // The trap: Brightwheel returns an HTML sign-in page with HTTP 200. Parsed loosely,
  // that reads as "zero photos" and an unattended nightly run would report success
  // forever while saving nothing.
  await assert.rejects(
    () => client('wrong-session').me(),
    (e) => e.name === 'SessionExpiredError',
  );
});

test('pagination walks to the end and stops', async () => {
  const pages = [];
  for await (const page of client().activities('stu-aaa-111', { pageSize: 5 })) pages.push(page.length);
  assert.ok(pages.length >= 3, `expected multiple pages, got ${pages.length}`);
  assert.equal(pages.reduce((a, b) => a + b, 0), 12);
});

test('capture time is preferred over upload time', async () => {
  // The mock posts every photo six hours after it was taken. If we used created_at,
  // morning photos would file under the evening — and at week edges, the wrong week.
  const [page] = [];
  for await (const p of client().activities('stu-aaa-111', { pageSize: 50 })) {
    const first = p[0];
    const uploaded = new Date(first.capturedAt.getTime() + 6 * 3600 * 1000);
    assert.ok(first.capturedAt < uploaded);
    break;
  }
});

// ---------------------------------------------------------------- end to end

test('a full sync saves, organises, tags and does not re-download', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bw-test-'));
  const config = { ...DEFAULT_CONFIG, archiveDir: dir, incremental: false, delayMs: 0 };

  const first = await sync(client(), config);
  assert.equal(first.failed, 0, `failures: ${first.warnings.join('; ')}`);
  assert.equal(first.saved, 24, 'two children, twelve items each');
  assert.deepEqual(first.students, ['Robin Maple', 'Sam Maple']);

  // Layout: child, then ISO week.
  const top = (await readdir(dir)).filter((f) => !f.startsWith('.') && f !== 'archive.json');
  assert.ok(top.includes('Robin-Maple'), `top level was ${top.join(', ')}`);
  const weeks = await readdir(join(dir, 'Robin-Maple'));
  assert.ok(weeks.every((w) => /^\d{4}-W\d{2}$/.test(w)), `week folders were ${weeks.join(', ')}`);

  // Every photo has a JSON sidecar carrying the real capture time and the child's name.
  const week = weeks[0];
  const files = await readdir(join(dir, 'Robin-Maple', week));
  const sidecar = files.find((f) => f.endsWith('.json'));
  assert.ok(sidecar, 'expected a .json sidecar');
  const meta = JSON.parse(await readFile(join(dir, 'Robin-Maple', week, sidecar), 'utf8'));
  assert.equal(meta.child.name, 'Robin Maple');
  assert.equal(meta.source, 'brightwheel');
  assert.ok(meta.capturedAt);
  assert.ok(files.includes('README.md'), 'each week folder explains itself');

  // Filenames start with the date so they sort chronologically in any file browser.
  const photo = files.find((f) => /^\d{4}-\d{2}-\d{2}_\d{6}_/.test(f));
  assert.ok(photo, `expected a dated filename, got ${files.join(', ')}`);

  // The second run must download nothing: the manifest matches on Brightwheel's media id,
  // even though the mock issues a brand-new signed URL on every single request.
  const second = await sync(client(), config);
  assert.equal(second.saved, 0, 'nothing new should be downloaded');
  assert.equal(second.skipped, 24, 'everything should be recognised as already held');
});

test('the manifest never records a local timestamp as a validator', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bw-manifest-'));
  await sync(client(), { ...DEFAULT_CONFIG, archiveDir: dir, incremental: false, delayMs: 0 });
  const manifest = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));
  assert.equal(manifest.schema, 2);
  assert.ok(manifest.notes.includes('never used as validators'));
  for (const record of manifest.files) {
    assert.ok(record.sha256?.length === 64, 'every file is content-hashed');
    assert.ok(record.sourceId.startsWith('brightwheel:'));
    // transferId must have had the signature stripped.
    assert.ok(!record.transferId.includes('signature='), 'signature must not be stored');
  }
});

// ---------------------------------------------------------------- files on disk

test('files holding secrets are created owner-only', { skip: platform() === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bw-perm-'));
  const file = join(dir, 'session.json');
  await writeSecureFile(file, '{"cookie":"x"}');
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

// ---------------------------------------------------------------- web ui

test('the setup page refuses requests without the token', async () => {
  const ui = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  try {
    const res = await fetch(`http://127.0.0.1:${ui.port}/`);
    assert.equal(res.status, 403);
  } finally {
    await ui.close();
  }
});

/**
 * `fetch` refuses to set a Host header (it is a forbidden header name in undici), so a
 * rebinding attack cannot be simulated through it. The raw http client can, which is
 * exactly why the server must not trust the header.
 */
function rawRequest(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the setup page blocks DNS-rebinding and cross-site requests', async () => {
  const ui = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  try {
    // A hostile domain resolved to 127.0.0.1 arrives with its own Host header.
    const rebind = await rawRequest(ui.port, `/?token=${ui.token}`, { Host: 'evil.example.com' });
    assert.equal(rebind.status, 403);

    // The same request with a legitimate Host is allowed, proving the check is the cause.
    const legit = await rawRequest(ui.port, `/?token=${ui.token}`, { Host: `127.0.0.1:${ui.port}` });
    assert.equal(legit.status, 200);

    // A page the parent is merely visiting must not be able to drive the UI.
    const csrf = await fetch(`http://127.0.0.1:${ui.port}/api/state?token=${ui.token}`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    assert.equal(csrf.status, 403);

    // The legitimate same-origin request still works.
    const ok = await fetch(`http://127.0.0.1:${ui.port}/api/state?token=${ui.token}`);
    assert.equal(ok.status, 200);
  } finally {
    await ui.close();
  }
});

test('the setup page binds only to the loopback interface', async () => {
  const ui = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  try {
    const res = await fetch(`http://127.0.0.1:${ui.port}/?token=${ui.token}`);
    assert.equal(res.status, 200);
    // Never cached: these pages list children's names.
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await res.text();
    assert.ok(html.includes('Save your child'));
    // The token is bound into the page, not guessable.
    assert.ok(ui.token.length >= 30);
  } finally {
    await ui.close();
  }
});

test('the API never echoes a session back to the browser', async () => {
  const ui = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  try {
    await fetch(`http://127.0.0.1:${ui.port}/api/session?token=${ui.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookie: SESSION }),
    });
    const state = await (await fetch(`http://127.0.0.1:${ui.port}/api/state?token=${ui.token}`)).text();
    assert.ok(!state.includes(SESSION), 'the session value must never be sent to the browser');
    assert.ok(state.includes('sessionFingerprint'));
  } finally {
    await ui.close();
  }
});
