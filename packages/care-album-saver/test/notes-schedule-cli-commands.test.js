// First, before anything that can read the config directory, the photos folder or the log
// (see scripts/test-env.js). Every command here runs in a folder of its own under tmpdir().
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { writeSecureFile } from '../dist/paths.js';
import { startMockBrightwheel } from '../dist/index.js';

/**
 * The security review's NOTE-level findings on the command line: processes-8 (recheck's
 * command), and from §4.4 the login race, the log's modes on a scheduled run with nothing to
 * do, and the Photos notice. Where the session may be sent is in
 * notes-schedule-cli-outbound.test.js.
 */

before(assertIsolatedConfigDir);

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const SESSION = 'test-session-value';
const posixOnly = process.platform === 'win32' ? 'file modes and /bin/sh are POSIX' : false;

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

// ---------------------------------------------------------------- processes-8

test('processes-8: recheck suggests --child by id, never a name from Brightwheel inside double quotes', async () => {
  const { env } = await computer({ config: { includeStudents: ['stu-aaa-111'] } });
  const result = await cli(['recheck', '--base-url', `${mock.url}/api/v1`], env);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /care-album-saver run --child stu-bbb-222\n/);
  assert.doesNotMatch(result.stdout, /--child "/);
});

test('processes-8: an id a shell would read specially is single-quoted, and the shell gives it back exactly', { skip: posixOnly }, async () => {
  const odd = "it's $(echo INJECTED) `echo TICKED` \"q\" \\ ;";
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://x').pathname;
    const body = path === '/api/v1/users/me'
      ? { object_id: 'g-1', email: null }
      : path === '/api/v1/guardians/g-1/students'
        ? { students: [{ student: { object_id: 'stu-1', first_name: 'Robin', last_name: 'Maple' } }, { student: { object_id: odd, first_name: '$(echo NAME)', last_name: '"Maple"' } }] }
        : null;
    response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { env } = await computer({ config: { includeStudents: ['stu-1'] } });
    const result = await cli(['recheck', '--base-url', `http://127.0.0.1:${server.address().port}/api/v1`], env);
    assert.equal(result.code, 0, result.stdout);
    const command = /^ {4}care-album-saver run (.*)$/m.exec(result.stdout)?.[1];
    assert.ok(command, result.stdout);
    assert.doesNotMatch(command, /NAME|Maple/, 'no name in the command');
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', `printf '%s\\n' ${command}`]);
    assert.equal(stdout, `--child\n${odd}\n`, 'two words, the second exactly the id, and nothing ran');
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- §4.4: the login race

/** `login`, with the paste typed once the prompt is up and `meanwhile` done just before. */
function login(args, env, value, meanwhile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'login', ...args], { env });
    let text = '';
    let typed = false;
    const onData = async (d) => {
      text += d;
      if (typed || !/Paste it here/.test(text)) return;
      typed = true;
      try {
        await meanwhile();
        child.stdin.write(`${value}\n`);
      } catch (error) {
        child.kill();
        reject(error);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { text += d; });
    const giveUp = setTimeout(() => child.kill(), 20000);
    child.on('close', (code) => {
      clearTimeout(giveUp);
      resolve({ code, text });
    });
  });
}

test('§4.4 login race: login saves only what its own options change, into the settings as they are when it saves', async () => {
  const { configDir, env } = await computer({ session: null, config: { tagNote: false } });
  const record = { time: '19:00', mechanism: 'launchd', location: '/somewhere', installedAt: new Date().toISOString(), cliPath: '/opt/cas/dist/cli.js' };
  const chosen = await mkdtemp(join(tmpdir(), 'cas-notes-cli-chosen-'));
  const onCommandLine = await mkdtemp(join(tmpdir(), 'cas-notes-cli-flag-'));

  // While the parent is finding the cookie, the setup page turns the daily run on and picks a folder.
  const result = await login(['--base-url', `${mock.url}/api/v1`, '--no-name-tag'], env, SESSION, async () => {
    const now = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8'));
    await writeSecureFile(join(configDir, 'config.json'), JSON.stringify({ ...now, schedule: record, archiveDir: chosen }));
  });
  assert.equal(result.code, 0, result.text);
  let saved = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8'));
  assert.deepEqual(saved.schedule, record, 'the daily run turned on meanwhile is still recorded');
  assert.equal(saved.archiveDir, chosen, 'and the folder chosen meanwhile');
  assert.equal(saved.tagNote, false, 'settings from before are kept');
  assert.equal(saved.tagChildName, false, 'and what the command line said is saved');
  assert.equal(JSON.parse(await readFile(join(configDir, 'session.json'), 'utf8')).cookie, SESSION);

  // --dir is the command line's to say, and it still wins over the folder.
  const again = await login(['--base-url', `${mock.url}/api/v1`, '--dir', onCommandLine], env, SESSION, async () => {});
  assert.equal(again.code, 0, again.text);
  saved = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8'));
  assert.equal(saved.archiveDir, onCommandLine);
  assert.deepEqual(saved.schedule, record);
});

// ---------------------------------------------------------------- log-dir mode

test('log-dir mode: a scheduled run with nothing to do still puts the log back to owner-only', { skip: posixOnly }, async () => {
  const { configDir, logs, env } = await computer({
    config: { schedule: { time: '00:00', mechanism: 'cron', location: 'crontab', installedAt: new Date().toISOString() } },
  });
  await writeSecureFile(
    join(configDir, 'last-run.json'),
    JSON.stringify({ at: new Date().toISOString(), ok: true, saved: 0, failed: 0, message: 'x', trigger: 'schedule' }),
  );
  // As cron's shell leaves them on Linux: `>>` creates the log at the login umask before Node runs.
  await chmod(logs, 0o755);
  await writeFile(join(logs, 'daily.log'), '');
  await chmod(join(logs, 'daily.log'), 0o644);

  const result = await cli(['run', '--scheduled'], env);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /Already up to date for today/);
  assert.equal((await stat(logs)).mode & 0o777, 0o700);
  assert.equal((await stat(join(logs, 'daily.log'))).mode & 0o777, 0o600);
});

// ---------------------------------------------------------------- §4.4: the Photos notice

test('§4.4 Photos notice: while the Photos record is damaged the daily run remembers it said so, and forgets once it is readable', async (t) => {
  if (process.platform !== 'darwin') return t.skip('the Photos step only runs on macOS');
  const { configDir, photos, env } = await computer({
    config: { addToPhotos: true, addToPhotosFrom: new Date(0).toISOString() },
  });
  try {
    await writeFile(join(configDir, 'photos.json'), '{ not json');
    const notices = async () => JSON.parse(await readFile(join(configDir, 'notices.json'), 'utf8').catch(() => '{}'));

    const first = await cli(['run', '--scheduled', '--base-url', `${mock.url}/api/v1`], env);
    assert.match(first.stdout, /Not added to Photos: .*cannot be read/, first.stdout);
    const said = (await notices()).photos;
    assert.match(said ?? '', /cannot be read/, 'the problem the notice was for is written down');

    await cli(['run', '--scheduled', '--base-url', `${mock.url}/api/v1`], env);
    assert.equal((await notices()).photos, said, 'the same problem the next evening: nothing new to say');

    await rm(join(configDir, 'photos.json'));
    await cli(['run', '--scheduled', '--base-url', `${mock.url}/api/v1`], env);
    assert.equal((await notices()).photos, undefined, 'readable again, so the record remembers from here on');
    assert.ok(existsSync(join(configDir, 'notices.json')));
  } finally {
    await rm(photos, { recursive: true, force: true });
  }
});
