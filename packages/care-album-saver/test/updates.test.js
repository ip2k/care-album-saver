// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, configPath, startWebUi, writeSecureFile } from '../dist/index.js';
import { checkForUpdate, compareVersions, parseRelease, updateStatus, updateSteps } from '../dist/updates.js';
import { installKind, readCommit } from '../dist/version.js';
import { PAGE } from '../dist/web/page.js';

/**
 * Checking for a newer version (2026-09-23). The owner's decisions: GitHub Releases as the
 * source, and ask once — nothing is sent to anyone until the parent has said yes. Then the
 * steps to update, for the way this copy was installed.
 */

before(assertIsolatedConfigDir);

async function freshConfigDir() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-updates-'));
  return assertIsolatedConfigDir();
}

const RELEASE = {
  tag_name: 'v0.2.0',
  html_url: 'https://github.com/ip2k/care-album-saver/releases/tag/v0.2.0',
  published_at: '2026-09-30T12:00:00Z',
  draft: false,
  prerelease: false,
  body: '## Added\r\n- A photo viewer.\r\n',
};

/** A pretend GitHub that counts its callers. */
function github(status = 200, body = RELEASE) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

/** A network that must not be touched. */
const untouchable = async () => { throw new Error('the network was asked when it must not be'); };

test('versions compare numerically, and a pre-release is older than its release', () => {
  assert.ok(compareVersions('0.2.0', '0.1.9') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0, 'numerically, not as text');
  assert.ok(compareVersions('v1.0.0', '1.0.0') === 0);
  assert.ok(compareVersions('1.0.0-beta.1', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0);
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-beta') < 0);
});

test('GitHub\'s answer is kept only if it is a release of this repository', () => {
  const r = parseRelease(RELEASE);
  assert.deepEqual({ ...r, notes: undefined }, {
    version: '0.2.0', tag: 'v0.2.0', url: RELEASE.html_url, publishedAt: RELEASE.published_at, notes: undefined,
  });
  assert.equal(r.notes, '## Added\n- A photo viewer.\n', 'Windows line ends are made plain');
  assert.equal(parseRelease({ ...RELEASE, html_url: 'https://evil.example/releases/tag/v0.2.0' }), null, 'a link anywhere else');
  assert.equal(parseRelease({ ...RELEASE, html_url: 'https://github.com/someone/else/releases/tag/v0.2.0' }), null);
  assert.equal(parseRelease({ ...RELEASE, tag_name: 'latest' }), null, 'a tag that is not a version');
  assert.equal(parseRelease({ ...RELEASE, draft: true }), null);
  assert.equal(parseRelease({ ...RELEASE, prerelease: true }), null);
  assert.equal(parseRelease('not an object'), null);
  assert.ok(parseRelease({ ...RELEASE, body: 'x'.repeat(50_000) }).notes.length < 21_000, 'notes are capped');
});

test('asked at most once a day; a failure is remembered and retried after an hour, not at once', async () => {
  await freshConfigDir();
  const gh = github();
  const t0 = new Date('2026-10-01T09:00:00Z');
  const first = await checkForUpdate({ fetch: gh.fetch, now: t0 });
  assert.equal(first.latest.version, '0.2.0');
  assert.equal(gh.calls.length, 1);
  assert.equal(gh.calls[0].url, 'https://api.github.com/repos/ip2k/care-album-saver/releases/latest');
  assert.equal(gh.calls[0].init.headers['user-agent'], undefined, 'no User-Agent naming the tool');
  assert.equal(gh.calls[0].init.headers.cookie, undefined);

  await checkForUpdate({ fetch: gh.fetch, now: new Date(t0.getTime() + 23 * 3600_000) });
  assert.equal(gh.calls.length, 1, 'not again the same day');
  await checkForUpdate({ fetch: gh.fetch, now: new Date(t0.getTime() + 30_000), force: true });
  assert.equal(gh.calls.length, 1, '"Check now" twice in a minute asks once');
  await checkForUpdate({ fetch: gh.fetch, now: new Date(t0.getTime() + 120_000), force: true });
  assert.equal(gh.calls.length, 2, '"Check now" asks');

  // A day later GitHub is limiting: the previous answer is kept, and the reason remembered.
  const limited = github(403, { message: 'rate limited' });
  const t1 = new Date(t0.getTime() + 25 * 3600_000);
  const after = await checkForUpdate({ fetch: limited.fetch, now: t1 });
  assert.equal(after.latest.version, '0.2.0', 'the last answer is kept');
  assert.match(after.error, /limiting/);
  await checkForUpdate({ fetch: limited.fetch, now: new Date(t1.getTime() + 30 * 60_000) });
  assert.equal(limited.calls.length, 1, 'not retried within the hour');
  await checkForUpdate({ fetch: limited.fetch, now: new Date(t1.getTime() + 61 * 60_000) });
  assert.equal(limited.calls.length, 2, 'retried after it');
});

test('no release yet is an answer, not an error; a strange answer is an error', async () => {
  await freshConfigDir();
  const none = await checkForUpdate({ fetch: github(404, { message: 'Not Found' }).fetch });
  assert.deepEqual([none.latest, none.error, typeof none.checkedAt], [null, null, 'string']);

  await freshConfigDir();
  const odd = await checkForUpdate({ fetch: github(200, { tag_name: 'v1.0.0', html_url: 'https://elsewhere.example/' }).fetch });
  assert.equal(odd.latest, null);
  assert.match(odd.error, /not a release/);

  await freshConfigDir();
  const down = await checkForUpdate({ fetch: async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); } });
  assert.match(down.error, /could not be reached: getaddrinfo ENOTFOUND/);
});

test('under test the real network is refused, so no test can ever ask GitHub', async () => {
  await freshConfigDir();
  assert.equal(process.env.CARE_ALBUM_NO_UPDATE_CHECK, '1');
  const refused = await checkForUpdate();
  assert.match(refused.error, /CARE_ALBUM_NO_UPDATE_CHECK/);
});

test('nothing is sent before the parent says yes, or after they say no', async () => {
  await freshConfigDir();
  const unasked = await updateStatus({ ...DEFAULT_CONFIG }, { fetch: untouchable });
  assert.deepEqual([unasked.asked, unasked.enabled, unasked.available], [false, false, false]);
  const declined = await updateStatus({ ...DEFAULT_CONFIG, checkForUpdates: false }, { fetch: untouchable });
  assert.deepEqual([declined.asked, declined.enabled], [true, false]);

  const gh = github();
  const yes = await updateStatus({ ...DEFAULT_CONFIG, checkForUpdates: true }, { fetch: gh.fetch, version: { version: '0.1.0', commit: 'abc1234' } });
  assert.equal(yes.available, true);
  const same = await updateStatus({ ...DEFAULT_CONFIG, checkForUpdates: true }, { fetch: gh.fetch, version: { version: '0.2.0', commit: null } });
  assert.equal(same.available, false, 'the same version is not an update');
  assert.equal(gh.calls.length, 1);
});

test('how it was installed, from where its files are', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'cas-kind-'));
  const kind = (packageDir, extra = {}) => installKind({ packageDir, repoRoot: fixture, inContainer: false, ...extra });
  assert.equal(kind('/Users/sam/.npm/_npx/1a2b3c/node_modules/care-album-saver'), 'npx');
  assert.equal(kind('/Users/sam/Library/Caches/pnpm/dlx/abcdef/node_modules/care-album-saver'), 'pnpm-dlx');
  assert.equal(kind('/private/var/folders/xy/T/bunx-501-care-album-saver@latest/node_modules/care-album-saver'), 'bunx');
  assert.equal(kind('/tmp/xfs-1a2b3c4d/dlx-12345/node_modules/care-album-saver'), 'yarn-dlx');
  assert.equal(kind('/opt/homebrew/lib/node_modules/care-album-saver'), 'npm-global');
  assert.equal(kind('/Users/sam/.nvm/versions/node/v22.0.0/lib/node_modules/care-album-saver'), 'npm-global');
  assert.equal(kind('C:\\Users\\Sam\\AppData\\Roaming\\npm\\node_modules\\care-album-saver', { separator: '\\' }), 'npm-global');
  assert.equal(kind('/Users/sam/Library/pnpm/global/5/node_modules/care-album-saver'), 'pnpm-global');
  assert.equal(kind('/Users/sam/.config/yarn/global/node_modules/care-album-saver'), 'yarn-global');
  assert.equal(kind('C:\\Users\\Sam\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\care-album-saver', { separator: '\\' }), 'yarn-global');
  assert.equal(kind('/Users/sam/.bun/install/global/node_modules/care-album-saver'), 'bun-global');
  assert.equal(kind('/Users/sam/projects/thing/node_modules/care-album-saver'), 'npm-local');

  // A folder of the repository's files: downloaded, then a clone once it has .git; docker wins.
  const pkg = join(fixture, 'packages', 'care-album-saver');
  assert.equal(kind(pkg), 'unknown');
  await writeFile(join(fixture, 'pnpm-workspace.yaml'), 'packages: ["packages/*"]\n');
  assert.equal(kind(pkg), 'download');
  await mkdir(join(fixture, '.git'));
  assert.equal(kind(pkg), 'git');
  assert.equal(kind(pkg, { inContainer: true }), 'docker');
  // Installed with npm inside somebody's own git project: npm's, not a clone of this one.
  assert.equal(kind(join(fixture, 'node_modules', 'care-album-saver')), 'npm-local');
  await writeFile(join(fixture, '.care-album-saver-production'), 'production\n');
  assert.equal(kind(pkg), 'production');
});

test('the steps to update, for every way of installing', () => {
  const where = { root: '~/care-album-saver', source: '~/Developer/brightwheel-archive' };
  const git = updateSteps('git', where);
  assert.deepEqual(git.commands, ['cd ~/care-album-saver', 'git pull', 'pnpm install', 'pnpm build']);
  const prod = updateSteps('production', where);
  assert.deepEqual(prod.commands, ['cd ~/Developer/brightwheel-archive', 'git switch main', 'git pull', 'node scripts/deploy.js']);
  assert.deepEqual(updateSteps('docker', where).commands, ['git pull', 'docker build -t care-album-saver .']);
  assert.deepEqual(updateSteps('download', where).commands, ['cd ~/care-album-saver', 'pnpm install', 'pnpm build']);
  assert.deepEqual(updateSteps('npm-global').commands, ['npm install -g care-album-saver@latest']);
  assert.deepEqual(updateSteps('pnpm-global').commands, ['pnpm add -g care-album-saver@latest']);
  assert.deepEqual(updateSteps('yarn-global').commands, ['yarn global add care-album-saver@latest']);
  assert.deepEqual(updateSteps('bun-global').commands, ['bun add -g care-album-saver@latest']);
  assert.deepEqual(updateSteps('npm-local').commands, ['npm install care-album-saver@latest']);
  assert.deepEqual(updateSteps('npx').commands, ['npx care-album-saver@latest setup']);
  assert.deepEqual(updateSteps('pnpm-dlx').commands, ['pnpm dlx care-album-saver@latest setup']);
  assert.deepEqual(updateSteps('yarn-dlx').commands, ['yarn dlx care-album-saver@latest setup']);
  assert.deepEqual(updateSteps('bunx').commands, ['bunx care-album-saver@latest setup']);
  assert.deepEqual(updateSteps('unknown').commands, [], 'no guessing: the guide instead');
  for (const k of ['production', 'docker', 'git', 'download', 'npm-global', 'npx', 'unknown']) {
    const s = updateSteps(k, where);
    assert.ok(s.installedAs && s.before, `${k} says how it was installed and what to do`);
  }
});

test('the commit is read from .git without running git: a branch, packed refs, detached, a worktree', async () => {
  const sha = 'd2496d2a0c6a1b7e8f90123456789abcdef01234';
  const root = await mkdtemp(join(tmpdir(), 'cas-commit-'));
  await mkdir(join(root, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(readCommit(root), null, 'a branch with no commit yet');
  await writeFile(join(root, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${sha} refs/heads/main\n`);
  assert.equal(readCommit(root), 'd2496d2', 'from packed refs');
  await writeFile(join(root, '.git', 'refs', 'heads', 'main'), `${'e'.repeat(40)}\n`);
  assert.equal(readCommit(root), 'eeeeeee', 'a loose ref wins');
  await writeFile(join(root, '.git', 'HEAD'), `${sha}\n`);
  assert.equal(readCommit(root), 'd2496d2', 'detached');

  const own = join(root, '.git', 'worktrees', 'wt');
  await mkdir(own, { recursive: true });
  await writeFile(join(own, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(own, 'commondir'), '../..\n');
  const wt = await mkdtemp(join(tmpdir(), 'cas-commit-wt-'));
  await writeFile(join(wt, '.git'), `gitdir: ${own}\n`);
  assert.equal(readCommit(wt), 'eeeeeee', 'a worktree finds its branch in the common folder');
  assert.equal(readCommit(await mkdtemp(join(tmpdir(), 'cas-commit-none-'))), null);
});

test('over HTTP: the answer, the question, "Check now" only when on, and a settings patch cannot switch it on', async () => {
  await freshConfigDir();
  const gh = github();
  const handle = await startWebUi({ updates: { fetch: gh.fetch, version: { version: '0.1.0', commit: 'abc1234' }, install: 'git', root: '/somewhere/care-album-saver' } });
  const call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-setup-token': handle.token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    const first = await call('/api/update');
    assert.deepEqual([first.body.asked, first.body.enabled, first.body.available], [false, false, false]);
    assert.equal(gh.calls.length, 0, 'not asked, not sent');
    assert.equal((await call('/api/update', { check: true })).status, 409, '"Check now" needs it switched on');

    const patched = await call('/api/config', { checkForUpdates: true });
    assert.equal(patched.status, 200);
    assert.equal(JSON.parse(await readFile(configPath(), 'utf8')).checkForUpdates, null, 'the settings patch cannot answer for the parent');

    const yes = await call('/api/update', { enabled: true });
    assert.equal(yes.status, 200);
    assert.deepEqual([yes.body.asked, yes.body.enabled, yes.body.available, yes.body.latest.version], [true, true, true, '0.2.0']);
    assert.equal(gh.calls.length, 1, 'saying yes is the first check');
    assert.deepEqual(yes.body.how.commands, ['cd /somewhere/care-album-saver', 'git pull', 'pnpm install', 'pnpm build']);
    assert.equal(yes.body.updatingDocUrl, 'https://github.com/ip2k/care-album-saver/blob/main/docs/UPDATING.md');

    const no = await call('/api/update', { enabled: false });
    assert.deepEqual([no.body.enabled, no.body.available, no.body.latest], [false, false, null], 'switched off, nothing shown');
    assert.equal((await call('/api/update', { nonsense: 1 })).status, 400);
  } finally {
    await handle.close();
  }
});

test('the page: a pill, the question asked once, a switch in Settings, and notes that are never HTML', () => {
  assert.match(PAGE, /<button class="update-pill" id="btn-update" type="button" aria-haspopup="dialog" hidden>/);
  assert.match(PAGE, /<li id="ask-updates" hidden><b>Check for new versions once a day\?<\/b>/);
  assert.match(PAGE, /<input type="checkbox" id="checkForUpdates"/);
  assert.match(PAGE, /<dialog id="dlg-update" aria-labelledby="h-update">/);
  const paint = PAGE.slice(PAGE.indexOf('function paintNotes'), PAGE.indexOf('$(\'btn-updates-yes\')'));
  assert.ok(paint.length > 0);
  assert.doesNotMatch(paint, /innerHTML/, 'release notes are text nodes, whatever they contain');
});
