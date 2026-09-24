// First, before anything that can read the config directory, the photos folder or the log
// (see scripts/test-env.js). Every command here runs in a folder of its own under tmpdir().
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_CONFIG, loadSession } from '../dist/config.js';
import { writeSecureFile } from '../dist/paths.js';
import { BrightwheelClient, DEFAULT_BASE_URL, Secret, startMockBrightwheel, verify } from '../dist/index.js';

/**
 * Where the saved session may be sent: the security review's outbound-13 (--base-url),
 * docs-14 (a test must never reach the real Brightwheel), and outbound's verifier's doubled
 * CARE_ALBUM_SESSION.
 */

before(assertIsolatedConfigDir);

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const SESSION = 'test-session-value';

let mock;
before(async () => {
  mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 2 });
});
after(async () => {
  await mock?.close();
});

/** A computer of the test's own: settings, session, photos and log folders, all throwaway. */
async function computer({ session = SESSION, config = {} } = {}) {
  const configDir = await mkdtemp(join(tmpdir(), 'cas-notes-cli-config-'));
  const photos = await mkdtemp(join(tmpdir(), 'cas-notes-cli-photos-'));
  const logs = await mkdtemp(join(tmpdir(), 'cas-notes-cli-logs-'));
  if (session) await writeSecureFile(join(configDir, 'session.json'), JSON.stringify({ cookie: session, savedAt: new Date().toISOString() }));
  if (config) await writeSecureFile(join(configDir, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, archiveDir: photos, delayMs: 0, ...config }));
  const env = { ...process.env, CARE_ALBUM_CONFIG_DIR: configDir, CARE_ALBUM_DIR: photos, CARE_ALBUM_LOG_DIR: logs };
  delete env.CARE_ALBUM_SESSION;
  delete env.BRIGHTWHEEL_SESSION;
  return { configDir, photos, logs, env };
}

/** Run the command line; resolves with its exit status and output, whatever they are. */
function cli(args, env) {
  return promisify(execFile)(process.execPath, [CLI, ...args], { env }).then(
    ({ stdout }) => ({ code: 0, stdout }),
    (error) => ({ code: error.code, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` }),
  );
}

// ---------------------------------------------------------------- outbound-13

test('outbound-13: --base-url is refused unless it is https, or http to this computer, before anything is sent', async () => {
  const { env } = await computer();
  const before = mock.requests.length;
  for (const url of ['http://api.example.invalid/api/v1', 'http://192.0.2.1:8080/api/v1', 'http://localhost.example.invalid/', 'ftp://127.0.0.1/', 'not a web address']) {
    for (const command of ['verify', 'run', 'doctor']) {
      const result = await cli([command, '--base-url', url], env);
      assert.equal(result.code, 1, `${command} ${url}`);
      assert.match(result.stdout, /sent only over https, or to this computer itself|is not a web address/, `${command} ${url}`);
      assert.doesNotMatch(result.stdout, /Reachable|Session works|Looking for/, 'nothing went as far as a request');
    }
  }
  assert.equal(mock.requests.length, before);

  // An https address is a deliberate choice and is allowed; so is the mock on this computer.
  assert.equal((await cli(['where', '--base-url', 'https://api.example.invalid/v1'], env)).code, 0);
  const local = await cli(['doctor', '--base-url', `${mock.url}/api/v1`], env);
  assert.match(local.stdout, /Session works: yes/);

  const help = await cli(['--help'], env);
  assert.match(help.stdout, /--base-url <url> .*\n.*saved\s+session is sent to it, so it must be https, or http to\s+this computer itself/);
});

test('outbound-13: verify itself refuses an address the session must not go to, and sends nothing', async () => {
  let asked = 0;
  const fetchImpl = async () => {
    asked += 1;
    throw new Error('not reached');
  };
  await assert.rejects(verify(new Secret(SESSION), { baseUrl: 'http://api.example.invalid/v1', fetchImpl }), /sent only over https/);
  assert.equal(asked, 0);
});

// ---------------------------------------------------------------- docs-14

test('docs-14: under test nothing reaches the real Brightwheel, and doctor goes where --base-url says', async () => {
  assert.equal(process.env.CARE_ALBUM_NO_LIVE_API, '1', 'scripts/test-env.js set it');
  const { env } = await computer();

  const doctor = await cli(['doctor'], env);
  assert.equal(doctor.code, 1);
  assert.match(doctor.stdout, /Session saved: yes/, 'the offline part still answers');
  assert.match(doctor.stdout, /CARE_ALBUM_NO_LIVE_API is set .* Brightwheel itself was not contacted/);

  for (const command of [['verify'], ['recheck'], ['children'], ['run']]) {
    const result = await cli(command, env);
    assert.equal(result.code, 1, command.join(' '));
    assert.match(result.stdout, /CARE_ALBUM_NO_LIVE_API is set/, command.join(' '));
  }
  // Naming Brightwheel's own address is no way round it.
  assert.match((await cli(['verify', '--base-url', DEFAULT_BASE_URL], env)).stdout, /CARE_ALBUM_NO_LIVE_API is set/);
  await assert.rejects(verify(new Secret(SESSION)), /CARE_ALBUM_NO_LIVE_API is set/);

  const before = mock.requests.length;
  const pointed = await cli(['doctor', '--base-url', `${mock.url}/api/v1`], env);
  assert.equal(pointed.code, 0, pointed.stdout);
  assert.match(pointed.stdout, /Session works: yes/);
  assert.ok(mock.requests.slice(before).some((r) => r.path === '/api/v1/users/me'), 'doctor asked the mock');
});

// ---------------------------------------------------------------- CARE_ALBUM_SESSION

test('CARE_ALBUM_SESSION is read the way a paste is, so name=value or a Cookie header is not sent doubled', async () => {
  const value = 'NotARealSession' + 'Q'.repeat(60);
  const saved = { current: process.env.CARE_ALBUM_SESSION, old: process.env.BRIGHTWHEEL_SESSION };
  try {
    delete process.env.BRIGHTWHEEL_SESSION;
    for (const form of [value, `_brightwheel_v2=${value}`, `Cookie: theme=dark; _brightwheel_v2=${value}; lang=en`, `"${value}"`]) {
      process.env.CARE_ALBUM_SESSION = form;
      const loaded = await loadSession();
      assert.equal(loaded.session.expose(), value, form);

      let cookie = null;
      const client = new BrightwheelClient({
        session: loaded.session,
        baseUrl: 'https://api.example.invalid/v1',
        delayMs: 0,
        fetchImpl: async (_url, init) => {
          cookie = init.headers.Cookie;
          return new Response(JSON.stringify({ object_id: 'g-1' }), { headers: { 'content-type': 'application/json' } });
        },
      });
      await client.me();
      assert.equal(cookie, `_brightwheel_v2=${value}`, `one name, one value: ${form}`);
    }
    for (const unusable of ['_brightwheel_v2', 'a b', 'https://schools.mybrightwheel.com/']) {
      process.env.CARE_ALBUM_SESSION = unusable;
      assert.equal(await loadSession(), null, unusable);
    }
    // The pre-rename spelling is read the same way.
    delete process.env.CARE_ALBUM_SESSION;
    process.env.BRIGHTWHEEL_SESSION = `_brightwheel_v2=${value}`;
    assert.equal((await loadSession()).session.expose(), value);
  } finally {
    if (saved.current === undefined) delete process.env.CARE_ALBUM_SESSION;
    else process.env.CARE_ALBUM_SESSION = saved.current;
    if (saved.old === undefined) delete process.env.BRIGHTWHEEL_SESSION;
    else process.env.BRIGHTWHEEL_SESSION = saved.old;
  }
});
