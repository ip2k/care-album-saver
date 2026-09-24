// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockBrightwheel, startWebUi } from '../dist/index.js';

/**
 * The adversarial reviewers' findings on the setup server after the NOTE lanes
 * (docs/SECURITY-REVIEW-2026-09-23.md §4.6): a request that arrives while the server is closing
 * must not end the process (F4), and the address may carry the setup token only for a GET of
 * the page or /photo (F23).
 */

before(assertIsolatedConfigDir);

const SESSION = 'test-session-value';

let mock;
before(async () => { mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 1 }); });
after(async () => { await mock?.close(); });

async function freshUi() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-notes-warnings-server-'));
  delete process.env.CARE_ALBUM_SESSION;
  assertIsolatedConfigDir();
  return startWebUi({ baseUrl: `${mock.url}/api/v1` });
}

function raw(port, path, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers }, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

/** `promise`, or a failure after `ms`: a regression here shows as a hang, which must fail. */
function within(ms, promise, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: nothing after ${ms} ms`)), ms); }),
  ]);
}

test('F4: a request half-sent when the server starts closing is answered, never a crash', { timeout: 20_000 }, async () => {
  const ui = await freshUi();
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  const socket = connect(ui.port, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    let answer = '';
    socket.on('data', (chunk) => (answer += chunk));
    const ended = new Promise((resolve) => socket.once('close', resolve));
    socket.on('error', () => {});

    // Half a request, so the connection is open and the headers are still arriving.
    socket.write(`GET /api/state HTTP/1.1\r\nHost: 127.0.0.1:${ui.port}\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closing = ui.close();
    // The rest of the headers, after close() has begun: server.address() is null by now.
    socket.write(`x-setup-token: ${ui.token}\r\nConnection: close\r\n\r\n`);
    await within(5_000, ended, 'the half-sent request was never answered');
    await within(5_000, closing, 'close() never finished');
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(rejections.map(String), [], 'nothing escaped the handler as an unhandled rejection');
    assert.match(answer, /^HTTP\/1\.1 200 /, 'the request in flight is still answered');
  } finally {
    process.off('unhandledRejection', onRejection);
    // On a regression the connection is never answered, and it would keep close() and so
    // this file's process alive: end it here, so the failure is reported rather than a hang.
    socket.destroy();
    await ui.close();
  }
});

test('F23: the token in the address opens only a GET of the page or /photo', { timeout: 20_000 }, async () => {
  const ui = await freshUi();
  try {
    const t = `token=${ui.token}`;
    // Allowed: the two places a header cannot be sent.
    assert.equal(await raw(ui.port, `/?${t}`), 200);
    assert.notEqual(await raw(ui.port, `/photo?${t}&path=nothing.jpg`), 403, '/photo takes the token from the address');
    // Refused as if no token were given: any other path, and any other method.
    assert.equal(await raw(ui.port, `/anything-else?${t}`), 403);
    assert.equal(await raw(ui.port, `/api/state?${t}`), 403);
    assert.equal(await raw(ui.port, `/?${t}`, 'POST'), 403);
    assert.equal(await raw(ui.port, `/photo?${t}&path=nothing.jpg`, 'POST'), 403);
    // The header still works everywhere.
    assert.equal(await raw(ui.port, '/api/state', 'GET', { 'x-setup-token': ui.token }), 200);
    assert.equal(await raw(ui.port, '/anything-else', 'GET', { 'x-setup-token': ui.token }), 404);
  } finally {
    await ui.close();
  }
});
