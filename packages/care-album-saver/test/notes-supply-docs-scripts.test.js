// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * scripts/demo.js and scripts/screenshots.js redirect every folder the tool uses before the
 * tool is loaded (security review sc-10, 2026-09-24).
 *
 * CLAUDE.md's rule is two directories, not one: the config folder for the session, and the
 * photos folder, because config.js names the default photos folder the moment it is loaded
 * and anything that falls back to it saves into the real ~/Care Album Photos. Both scripts
 * redirected the config and log folders and neither set CARE_ALBUM_DIR; screenshots.js also
 * imported the tool at the top of the file, which loads it before any line of the script runs.
 *
 * So each script is run with a loader hook that stops it the instant the first of the tool's
 * own modules is loaded, and reports the folders it had set by then. Nothing of the tool runs,
 * no server starts and no browser opens; the child's HOME and temporary directory are
 * throwaway, and every folder the tool reads is stripped from its environment first, so what
 * is reported is what the script itself set.
 */

assertIsolatedConfigDir();

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const hooks = typeof nodeModule.registerHooks === 'function' ? false : 'this Node has no module.registerHooks (22.15 and later do)';
const FOLDERS = ['CARE_ALBUM_CONFIG_DIR', 'CARE_ALBUM_DIR', 'CARE_ALBUM_LOG_DIR', 'BRIGHTWHEEL_ARCHIVE_CONFIG_DIR', 'BRIGHTWHEEL_ARCHIVE_DIR'];

const HOOK = `
import { registerHooks } from 'node:module';
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.includes('/packages/care-album-saver/dist/')) {
      const keys = ${JSON.stringify(FOLDERS)};
      process.stdout.write('FOLDERS ' + JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))) + '\\n');
      process.exit(0);
    }
    return nextLoad(url, context);
  },
});
`;

const fold = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const inside = (child, parent) => fold(child).startsWith(fold(parent) + (fold(parent).endsWith(sep) ? '' : sep));

/** Run a script under the hook; return the folders it had set when the tool was first loaded. */
function foldersWhenLoaded(t, script) {
  const scratch = mkdtempSync(join(tmpdir(), 'cas-notes-scripts-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const hook = join(scratch, 'hook.mjs');
  writeFileSync(hook, HOOK);
  const temp = join(scratch, 'tmp');
  const home = join(scratch, 'home');
  mkdirSync(temp);
  mkdirSync(home);

  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CARE_ALBUM_|BRIGHTWHEEL_)/.test(k)));
  Object.assign(env, { HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp });
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, join(ROOT, 'scripts', script), '--port', '0'], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 60_000,
  });
  const line = r.stdout.split('\n').find((l) => l.startsWith('FOLDERS '));
  assert.ok(line, `${script} never loaded the tool, or failed first (status ${r.status}):\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.status, 0, r.stderr);
  // Nothing was made in the stand-in home: the tool had not yet run at all.
  assert.deepEqual(readdirSync(home), []);
  return { folders: JSON.parse(line.slice('FOLDERS '.length)), temp };
}

/** The script's own photos folder, inside node_modules; removed again if this made it. */
function scratchPhotos(t, name) {
  const cache = join(ROOT, 'node_modules', '.cache');
  const dir = join(cache, name);
  // Only what this made, and only while still empty: a demo someone is running uses the same
  // folder. The folder first, then the cache folder it may have made on the way.
  const made = [dir, cache].filter((d) => !existsSync(d));
  t.after(() => {
    for (const d of made) if (existsSync(d) && readdirSync(d).length === 0) rmSync(d, { recursive: true, force: true });
  });
  return dir;
}

for (const [script, photos] of [['demo.js', 'care-album-saver-demo'], ['screenshots.js', 'care-album-saver-screenshots']]) {
  test(`${script} has set the config, photos and log folders before the tool is loaded (sc-10)`, { skip: hooks }, (t) => {
    const expectedPhotos = scratchPhotos(t, photos);
    const { folders, temp } = foldersWhenLoaded(t, script);
    assert.ok(folders.CARE_ALBUM_CONFIG_DIR && inside(folders.CARE_ALBUM_CONFIG_DIR, temp), `config: ${folders.CARE_ALBUM_CONFIG_DIR}`);
    assert.ok(folders.CARE_ALBUM_LOG_DIR && inside(folders.CARE_ALBUM_LOG_DIR, temp), `log: ${folders.CARE_ALBUM_LOG_DIR}`);
    assert.equal(fold(folders.CARE_ALBUM_DIR ?? ''), fold(expectedPhotos), 'the default photos folder is the script\'s own scratch one');
  });
}
