// First, before anything that can read the config directory or write an archive.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { request } from 'node:http';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  BrightwheelClient,
  DEFAULT_CONFIG,
  RUN_LOCK_FILENAME,
  Secret,
  configPath,
  startMockBrightwheel,
  startWebUi,
  sync,
  takeRunLock,
  writeSecureFile,
} from '../dist/index.js';
import { removeDuplicates, repairManifest } from '../dist/maintenance.js';

/**
 * The run lock is taken by everything that rewrites the list, and refuses in both directions.
 *
 * Security review 2026-09-23: missed-fs (repairing the list and removing duplicates rewrote
 * archive.json without the lock, so a run in another process and one of them erased each
 * other's changes) and web-5 (the page kept its maintenance out of a run's way, but not a run
 * out of its maintenance's). Every refusal is a sentence a parent can act on.
 */

const SESSION = 'test-session-value';
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

let mock;
before(assertIsolatedConfigDir);
before(async () => { mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 4 }); });
after(async () => { await mock?.close(); });

const client = () => new BrightwheelClient({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });
const configFor = (dir) => ({ ...DEFAULT_CONFIG, archiveDir: dir, delayMs: 0, incremental: false });
const exists = (p) => stat(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An archive with photos and a list in it, saved by a real run against the mock. */
async function archive() {
  const dir = await mkdtemp(join(tmpdir(), 'cas-lock2-'));
  const config = configFor(dir);
  const result = await sync(client(), config, () => {}, { allowTemporaryDir: true });
  assert.ok(result.saved > 0);
  return { dir, config };
}

/** The same photo on disk twice, both recorded: something removeDuplicates would really remove. */
async function withDuplicate(dir) {
  const file = join(dir, 'archive.json');
  const data = JSON.parse(await readFile(file, 'utf8'));
  const original = data.files[0];
  const copyRel = original.path.replace(/\.([a-z0-9]+)$/i, '-2.$1');
  await copyFile(join(dir, ...original.path.split('/')), join(dir, ...copyRel.split('/')));
  data.files.push({ ...original, path: copyRel, sourceId: `${original.sourceId}-again`, downloadedAt: new Date(Date.parse(original.downloadedAt) + 60_000).toISOString() });
  await writeFile(file, JSON.stringify(data, null, 2));
  return { copy: copyRel, copyAbsolute: join(dir, ...copyRel.split('/')) };
}

/** A record dropped from the list while its file stays: something repairManifest would really fix. */
async function withUnrecorded(dir) {
  const file = join(dir, 'archive.json');
  const data = JSON.parse(await readFile(file, 'utf8'));
  data.files.pop();
  await writeFile(file, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------- missed-fs: maintenance holds it too

test('repairing the list and removing a duplicate are refused while a run is saving, and change nothing', async () => {
  const { dir, config } = await archive();
  try {
    await withUnrecorded(dir);
    const { copy, copyAbsolute } = await withDuplicate(dir);
    const before = await readFile(join(dir, 'archive.json'), 'utf8');

    // Asked for in the middle of a real run, which holds the folder from start to finish.
    const refusals = [];
    await sync(client(), config, () => {
      if (refusals.length > 0) return;
      refusals.push(repairManifest(config).then(() => null, (e) => e));
      refusals.push(removeDuplicates(config, { confirm: [copy] }).then(() => null, (e) => e));
    }, { allowTemporaryDir: true });
    const [repair, removal] = await Promise.all(refusals);

    assert.equal(repair?.name, 'RunInProgressError');
    assert.match(repair.message, /Photos are being saved into this folder right now/);
    assert.match(repair.message, /The list was not repaired/);
    assert.match(repair.message, /Try again when that run has finished\./);
    assert.equal(removal?.name, 'RunInProgressError');
    assert.match(removal.message, /Nothing was deleted/);
    assert.equal(await exists(copyAbsolute), true, 'the duplicate was not touched');

    // Once the run is over, both go ahead.
    await removeDuplicates(config, { confirm: [copy] });
    assert.equal(await exists(copyAbsolute), false);
    const repaired = await repairManifest(config);
    assert.equal(typeof repaired.summary, 'string');
    assert.equal(await exists(join(dir, RUN_LOCK_FILENAME)), false, 'each let go of the lock');
    assert.notEqual(await readFile(join(dir, 'archive.json'), 'utf8'), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run is refused while the list is being repaired or duplicates removed, and says which', async () => {
  const { dir, config } = await archive();
  try {
    const listed = await readFile(join(dir, 'archive.json'), 'utf8');

    const repairing = await takeRunLock(dir, { purpose: 'repair' });
    await assert.rejects(sync(client(), config, () => {}, { allowTemporaryDir: true }), (error) => {
      assert.equal(error.name, 'RunInProgressError');
      assert.match(error.message, /The tool’s list of this folder is being repaired right now/);
      assert.match(error.message, /This run did not start/);
      assert.match(error.message, /Try again in a minute\./);
      return true;
    });
    // Nor does a second repair start beside the first.
    await assert.rejects(repairManifest(config), { name: 'RunInProgressError', message: /being repaired right now.*The list was not repaired/s });
    await repairing.release();

    const removing = await takeRunLock(dir, { purpose: 'duplicates' });
    await assert.rejects(sync(client(), config, () => {}, { allowTemporaryDir: true }), {
      name: 'RunInProgressError',
      message: /Extra copies of photos are being deleted from this folder right now/,
    });
    await removing.release();

    assert.equal(await readFile(join(dir, 'archive.json'), 'utf8'), listed, 'the refused run wrote nothing');
    const after = await sync(client(), config, () => {}, { allowTemporaryDir: true });
    assert.equal(after.stopped, false, 'and runs normally once the folder is free');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('repair and removal in a folder that does not exist yet find nothing, and make no folder for a lock', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'cas-lock2-none-')), 'not-yet');
  const config = configFor(dir);
  const repaired = await repairManifest(config);
  assert.equal(repaired.added + repaired.dropped, 0);
  await assert.rejects(removeDuplicates(config, { confirm: ['a.jpg'] }), /no longer a second copy/);
  assert.equal(await exists(dir), false);
});

// ---------------------------------------------------------------- web-5: the page, both ways

async function withPage(archiveDir, fn) {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-lock2-config-'));
  delete process.env.CARE_ALBUM_SESSION;
  assertIsolatedConfigDir();
  await writeSecureFile(configPath(), JSON.stringify(configFor(archiveDir)));
  const handle = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  const call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-setup-token': handle.token },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(call, handle);
  } finally {
    await handle.close();
  }
}

test('the page\'s maintenance answers 409, in words, while another process holds the folder', async () => {
  const { dir } = await archive();
  try {
    await withUnrecorded(dir);
    const { copy, copyAbsolute } = await withDuplicate(dir);
    await withPage(dir, async (call) => {
      // Standing in for the daily run in another process.
      const run = await takeRunLock(dir);
      try {
        const repair = await call('/api/maintenance/repair');
        assert.equal(repair.status, 409);
        assert.match(repair.body.error, /Photos are being saved into this folder right now.*The list was not repaired/s);

        const remove = await call('/api/maintenance/duplicates/remove', { paths: [copy] });
        assert.equal(remove.status, 409);
        assert.match(remove.body.error, /Nothing was deleted/);
        assert.equal(await exists(copyAbsolute), true);

        // The two looks, which would describe a list that is half written.
        for (const look of ['archive', 'duplicates']) {
          const answer = await call(`/api/maintenance/${look}`);
          assert.equal(answer.status, 409, look);
          assert.match(answer.body.error, /Look again when that run has finished/);
        }
        for (const answer of [repair, remove]) assert.doesNotMatch(answer.body.error, /Error|at .*\.js|\{/, 'no stack, no JSON');
      } finally {
        await run.release();
      }

      const fixed = await call('/api/maintenance/repair');
      assert.equal(fixed.status, 200);
      assert.equal(fixed.body.result.added, 1);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the page refuses to start a run, in words, while its own maintenance is in progress', async () => {
  const { dir } = await archive();
  try {
    await withPage(dir, async (call, handle) => {
      // A removal whose request body is still arriving: the server has taken it on and is
      // waiting for the list of paths, so it is in progress for as long as this stays open.
      const slow = request({
        host: '127.0.0.1',
        port: handle.port,
        method: 'POST',
        path: '/api/maintenance/duplicates/remove',
        headers: { 'content-type': 'application/json', 'x-setup-token': handle.token },
      });
      const answered = new Promise((resolve, reject) => {
        slow.on('response', (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        });
        slow.on('error', reject);
      });
      slow.write('{"paths":');

      let refused;
      try {
        for (let i = 0; i < 100 && !refused; i += 1) {
          const answer = await call('/api/sync');
          if (answer.status === 409) refused = answer;
          else await sleep(20);
        }
      } finally {
        // Finished whatever happened above, or the server could never close.
        slow.end('[]}');
      }
      assert.ok(refused, 'a run was refused while the removal was in progress');
      assert.match(refused.body.error, /being checked or tidied up on the Maintenance page right now\. Nothing was started\./);

      const removal = await answered;
      assert.equal(removal.status, 400);
      assert.match(removal.body.error, /Nothing was named for removal/);

      // And the claim came off with it: the next Start is judged on its own (no session here).
      const next = await call('/api/sync');
      assert.equal(next.status, 400);
      assert.match(next.body.error, /Not signed in yet/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the command line

test('check --repair and duplicates --remove say so, and change nothing, while a run holds the folder', async () => {
  const { dir } = await archive();
  try {
    await withUnrecorded(dir);
    const { copyAbsolute } = await withDuplicate(dir);
    const listed = await readFile(join(dir, 'archive.json'), 'utf8');
    // Held by this test's own process, which is certainly alive: a run in another process.
    await writeFile(join(dir, RUN_LOCK_FILENAME), JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
    const configDir = await mkdtemp(join(tmpdir(), 'cas-lock2-cli-'));
    const cli = (...args) =>
      promisify(execFile)(process.execPath, [CLI, ...args, '--dir', dir], { env: { ...process.env, CARE_ALBUM_CONFIG_DIR: configDir } })
        .then(({ stdout }) => ({ code: 0, stdout }), (error) => ({ code: error.code, stdout: error.stdout }));

    const repair = await cli('check', '--repair');
    assert.equal(repair.code, 1);
    assert.match(repair.stdout, /Photos are being saved into this folder right now.*The list was not repaired/s);

    const remove = await cli('duplicates', '--remove');
    assert.equal(remove.code, 1);
    assert.match(remove.stdout, /Nothing was deleted/);
    assert.doesNotMatch(remove.stdout, /Type yes/, 'not asked to confirm a deletion that could not happen');

    const look = await cli('check');
    assert.equal(look.code, 1);
    assert.match(look.stdout, /Look again when that run has finished/);

    assert.equal(await readFile(join(dir, 'archive.json'), 'utf8'), listed);
    assert.equal(await exists(copyAbsolute), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
