// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { startWebUi } from '../dist/index.js';
import { updateSteps } from '../dist/updates.js';

/**
 * The security review's WARNINGs about the setup page (docs/SECURITY-REVIEW-2026-09-23.md
 * §4.2), one section each.
 */

before(assertIsolatedConfigDir);

const execFileP = promisify(execFile);

async function freshConfigDir() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-page-warnings-'));
  delete process.env.CARE_ALBUM_SESSION;
  return assertIsolatedConfigDir();
}

const call = async (handle, path, body) => {
  const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-setup-token': handle.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ------------------------------------------------------------------ page-4

test('page-4: a folder is quoted for the shell the steps are for, and left alone when it needs nothing', () => {
  const git = (root, platform) => updateSteps('git', { root, platform }).commands[0];
  // The usual case reads exactly as before.
  assert.equal(git('~/care-album-saver', 'darwin'), 'cd ~/care-album-saver');
  assert.equal(git('/opt/care-album-saver', 'linux'), 'cd /opt/care-album-saver');
  assert.equal(git('C:\\Users\\robin\\care-album-saver', 'win32'), 'cd C:\\Users\\robin\\care-album-saver');

  // POSIX: single quotes, with ~/ outside them so it still means the home folder.
  assert.equal(git('~/My Tools/care album saver', 'darwin'), "cd ~/'My Tools/care album saver'");
  assert.equal(git('/Users/Some One/care-album-saver', 'linux'), "cd '/Users/Some One/care-album-saver'");
  assert.equal(git("/x/Robin's photos", 'darwin'), "cd '/x/Robin'\\''s photos'");
  assert.equal(git('/x/$(echo INJECTED)', 'linux'), "cd '/x/$(echo INJECTED)'");

  // Windows: double quotes, which cmd and PowerShell both read.
  assert.equal(git('C:\\Users\\Some One\\care-album-saver', 'win32'), 'cd "C:\\Users\\Some One\\care-album-saver"');
  assert.equal(git('C:\\Program Files (x86)\\care-album-saver', 'win32'), 'cd "C:\\Program Files (x86)\\care-album-saver"');

  // Every way of installing that names a folder.
  assert.equal(updateSteps('download', { root: '/a b', platform: 'linux' }).commands[0], "cd '/a b'");
  assert.equal(updateSteps('production', { source: '~/Code/a b', platform: 'darwin' }).commands[0], "cd ~/'Code/a b'");
  assert.equal(updateSteps('production', { source: 'D:\\a b', platform: 'win32' }).commands[0], 'cd "D:\\a b"');

  // Words standing in for an unknown folder are for the person to replace, not a folder.
  assert.equal(updateSteps('git', { platform: 'darwin' }).commands[0], 'cd the folder it is in');
  assert.equal(updateSteps('production', { platform: 'linux' }).commands[0], 'cd your development checkout');
});

test('page-4: the quoted command really does reach the folder in a POSIX shell', { skip: process.platform === 'win32' ? 'a POSIX shell; the Windows quoting is checked as text above' : false }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'cas-quote-home-'));
  // A space, a quote, brackets, an ampersand, and what would expand if it were not quoted.
  const folder = join(home, "Robin's Photos (2026) & more", 'a $HOME b', 'care album saver');
  await mkdir(folder, { recursive: true });
  const expected = realpathSync(folder);
  for (const [kind, where] of [
    ['git', { root: folder }],
    ['git', { root: '~/' + relative(home, folder) }],
    ['download', { root: folder }],
    ['production', { source: '~/' + relative(home, folder) }],
  ]) {
    const [cd] = updateSteps(kind, { ...where, platform: process.platform }).commands;
    const { stdout } = await execFileP('/bin/sh', ['-c', `${cd} && pwd -P`], { env: { ...process.env, HOME: home } });
    assert.equal(stdout.trim(), expected, `${kind}: ${cd}`);
  }
});

test('page-4: the server hands the page the quoted steps', async () => {
  await freshConfigDir();
  const root = process.platform === 'win32' ? 'C:\\Some Folder\\care-album-saver' : '/some folder/care-album-saver';
  const release = {
    tag_name: 'v9.9.0',
    html_url: 'https://github.com/ip2k/care-album-saver/releases/tag/v9.9.0',
    draft: false,
    prerelease: false,
    body: '',
  };
  const handle = await startWebUi({
    updates: { fetch: async () => json(200, release), version: { version: '0.1.0', commit: null }, install: 'git', root },
  });
  try {
    const yes = await call(handle, '/api/update', { enabled: true });
    assert.equal(yes.status, 200);
    assert.equal(yes.body.how.commands[0], process.platform === 'win32' ? `cd "${root}"` : `cd '${root}'`);
  } finally {
    await handle.close();
  }
});
