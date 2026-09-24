/**
 * Points the test run at a throwaway config directory, and proves it is pointed there.
 *
 * Tests start the real setup UI and the real config code paths. Without this, they read and
 * write the developer's ACTUAL config directory — on a Mac,
 * ~/Library/Application Support/care-album-saver — and the test suite overwrites a real
 * Brightwheel session with the mock's "test-session-value". That is not hypothetical: it
 * happened on 2026-09-21, and again on 2026-09-22 when a reviewer ran one file with
 * `node --test <file>`, which does not apply the --import in package.json.
 *
 * So this is not only preloaded by `pnpm test`: every test file that starts the UI or
 * touches config imports it FIRST, before the module under test, and calls
 * assertIsolatedConfigDir(). Importing twice is free — the preload and the import resolve
 * to the same module — and one file run on its own is then as safe as the whole suite.
 *
 * Tests may still override the variable themselves; the assignment below only fills it in
 * when unset.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

if (!process.env.CARE_ALBUM_CONFIG_DIR) {
  process.env.CARE_ALBUM_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cas-test-config-'));
}
// Both spellings, always. The project was renamed on 2026-09-22, and isolation is the one
// thing that must not wait for every last reader of the old name to be found: a module, a
// script or a stale build that still reads BRIGHTWHEEL_ARCHIVE_CONFIG_DIR gets the same
// throwaway directory rather than the developer's real one.
process.env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR = process.env.CARE_ALBUM_CONFIG_DIR;

// The config directory was only half of it. DEFAULT_CONFIG.archiveDir is
// defaultArchiveDir(), so a test — or an agent's throwaway script — that syncs without
// naming a folder writes a full archive into ~/Brightwheel Photos. That happened three
// times on 2026-09-22 while this very isolation was being written, which is the argument
// for making the bad state unrepresentable rather than remembering to pass a path.
if (!process.env.CARE_ALBUM_DIR) {
  process.env.CARE_ALBUM_DIR = mkdtempSync(join(tmpdir(), 'cas-test-photos-'));
}
process.env.BRIGHTWHEEL_ARCHIVE_DIR = process.env.CARE_ALBUM_DIR;

// The daily log names a child and the archive path, and the setup page now shows its tail.
// A test that reads it must not read the developer's real one.
if (!process.env.CARE_ALBUM_LOG_DIR) {
  process.env.CARE_ALBUM_LOG_DIR = mkdtempSync(join(tmpdir(), 'cas-test-logs-'));
}

// Adding to Photos drives the developer's real Photos app, and a library with iCloud Photos
// on would upload the mock's pictures to a real account. src/photos.ts refuses to start
// osascript at all while this is set; a test that exercises it passes its own stand-in.
process.env.CARE_ALBUM_NO_PHOTOS = '1';

// Checking for a new version asks GitHub. src/updates.ts refuses to while this is set; a test
// of it passes its own stand-in for the network.
process.env.CARE_ALBUM_NO_UPDATE_CHECK = '1';

// A scheduled run that fails says so with a desktop notification. A test of that failure
// must not put one on the developer's screen; src/schedule.ts's notify() refuses to start
// the real notifier while this is set, and a test of notify itself passes its own runner.
process.env.CARE_ALBUM_NO_NOTIFY = '1';

// Every test that reaches an API names the mock (--base-url, or baseUrl). One that forgot
// would send a session to the real Brightwheel — the mock's, or with a stray
// CARE_ALBUM_SESSION in the shell a real one. While this is set, the command line and
// `verify` refuse to send anything to Brightwheel's own address (refuseLiveApiUnderTest in
// src/config.ts). It can only stop a request, never send one elsewhere. Spawned commands
// inherit it with the rest of the environment.
process.env.CARE_ALBUM_NO_LIVE_API = '1';

/**
 * Resolve symlinks where we can, so that two spellings of one place compare equal.
 *
 * macOS reports its temp directory as `/var/folders/…`, which is a symlink to
 * `/private/var/folders/…`; a caller that has already resolved the path would otherwise
 * look as though it were somewhere else entirely. A path that does not exist yet cannot be
 * resolved, and is compared as written.
 */
function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * True when `child` is strictly below `parent`, both resolved.
 *
 * Case-folded on Windows, where `C:\Users\Sam\AppData\Local\Temp` and `c:\users\sam\...`
 * are the same directory and the CI runner is free to spell it either way.
 */
function isInside(child, parent) {
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const a = fold(canonical(child));
  const b = fold(canonical(parent));
  return a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * The same rule for the photos as for the session: a test may only archive somewhere
 * disposable. Called by assertIsolatedConfigDir, so every file that already guards its
 * config directory gets this for free.
 */
function assertIsolatedArchiveDir() {
  const dir = process.env.CARE_ALBUM_DIR;
  if (!dir) {
    throw new Error(
      'CARE_ALBUM_DIR is not set. Import scripts/test-env.js first: without it a ' +
        'sync built from DEFAULT_CONFIG archives into the real default photos folder ' +
        '(~/Care Album Photos, or ~/Brightwheel Photos where that already exists).',
    );
  }
  const scratch = process.env.CARE_ALBUM_TEST_SCRATCH;
  const allowed = scratch ? [tmpdir(), scratch] : [tmpdir()];
  if (!isAbsolute(dir) || !allowed.some((root) => isInside(dir, root))) {
    throw new Error(
      `CARE_ALBUM_DIR is ${dir}, which is not a throwaway test directory. A test ` +
        'must not write photographs anywhere a person keeps theirs.',
    );
  }
  return dir;
}

/**
 * Fail loudly rather than write a mock session over a real one.
 *
 * The import above cannot be the whole guard: it fills the variable in only when it is
 * unset, so a stray `CARE_ALBUM_CONFIG_DIR` already pointing at the real
 * directory would sail straight through it.
 *
 * The rule is positive on purpose. It used to be a list of three places the directory must
 * not be — `~/Library`, `~/.config`, `~/AppData` — which is a guess at where a real session
 * might live, and every place not on the list walked straight past it. A parent who has set
 * the variable to `~/brightwheel` because they keep their tools in their home folder would
 * have had that directory written over by a test run. So instead: a test config directory
 * must be inside the operating system's temp directory, which is where every test in this
 * repository makes one, or inside a directory whose owner has explicitly named it as test
 * scratch space in CARE_ALBUM_TEST_SCRATCH. Anywhere else is refused, whether or
 * not anyone has thought of it.
 */
export function assertIsolatedConfigDir() {
  const dir = process.env.CARE_ALBUM_CONFIG_DIR;
  if (!dir) {
    throw new Error('CARE_ALBUM_CONFIG_DIR is not set: import scripts/test-env.js before anything else.');
  }
  if (!isAbsolute(dir)) {
    throw new Error(`CARE_ALBUM_CONFIG_DIR is "${dir}", which is not a full path.`);
  }
  const scratch = process.env.CARE_ALBUM_TEST_SCRATCH;
  const allowed = scratch ? [tmpdir(), scratch] : [tmpdir()];
  if (allowed.some((root) => isInside(dir, root))) {
    assertIsolatedArchiveDir();
    return dir;
  }
  throw new Error(
    `CARE_ALBUM_CONFIG_DIR is ${dir}, which is not a throwaway test directory. ` +
      `A test config directory must be inside ${tmpdir()} (use mkdtemp), or inside a directory ` +
      `named by CARE_ALBUM_TEST_SCRATCH. Refusing, so that a real saved session is not ` +
      `overwritten with the mock's.`,
  );
}

/**
 * Whether `exiftool-vendored` is here — and what a test file should do when it is not.
 *
 * ExifTool is an optionalDependency. The tool degrades to JSON sidecars without it, and a
 * contributor whose machine cannot install the vendored binary must still be able to run
 * the suite, so the metadata tests skip rather than fail. But they skip VISIBLY: callers
 * pass the return value to node:test's `skip` option, which prints the reason and counts
 * the test in the "skipped" total. A test that quietly returns early is worse than no test,
 * because "94 passed" is then cited as proof of something nothing checked.
 *
 * On a continuous-integration runner that is not good enough either way. Every cell of the
 * matrix installs the optional dependency, so a cell where it failed to install is a broken
 * cell — and a green tick there would read as "the metadata claims hold" while meaning
 * "nothing about metadata was examined". Runners set CI, so there a missing ExifTool fails
 * the file outright. A cell that genuinely cannot have it opts out with
 * CARE_ALBUM_OPTIONAL_EXIFTOOL=1, which is a deliberate act someone has to write
 * down, rather than a silence.
 *
 * Returns false when ExifTool is present (node:test reads `skip: false` as "do not skip"),
 * and the reason string when it is absent and skipping is allowed.
 *
 * `load` is the caller's own `() => import('exiftool-vendored')`, and it has to be: this
 * file sits at the top of the workspace, where the optional dependency of one package is
 * not resolvable, so an import written here would report "missing" on a machine that has it.
 */
export async function exifToolSkipReason(load) {
  try {
    await load();
    return false;
  } catch (error) {
    const reason = `exiftool-vendored did not load; it is an optional dependency: ${error.message}`;
    if (process.env.CI && process.env.CARE_ALBUM_OPTIONAL_EXIFTOOL !== '1') {
      // On CI the optional dependency is expected to install, so a skip would be a green run
      // that proved nothing about what goes into a photo. Return false — "do not skip" — and
      // let each test fail where it reaches for ExifTool.
      //
      // Deliberately NOT a throw: this runs while a test file is still being evaluated, so
      // throwing takes the whole file down, including tests that have nothing to do with
      // metadata — stop-mid-listing, manifest races, the web-UI stop path. Failing the tests
      // that actually need ExifTool is the smaller, truer blast radius.
      process.stderr.write(
        `${reason}\nThis is CI, so the metadata tests will run and fail rather than skip. ` +
          'Set CARE_ALBUM_OPTIONAL_EXIFTOOL=1 for a runner that deliberately has none.\n',
      );
      return false;
    }
    return reason;
  }
}
