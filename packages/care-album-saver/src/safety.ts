import { realpathSync } from 'node:fs';
import { homedir as osHomedir, platform as osPlatform, tmpdir as osTmpdir } from 'node:os';
import path from 'node:path';
import { configDir, legacyConfigDir } from './paths.js';

/**
 * Where it is safe to put a child's photographs.
 *
 * This exists because the setup page used to accept any path at all and write there without
 * comment. A path can be wrong in three different ways, and only one of them is obvious:
 *
 *   1. It is a temporary directory. The operating system deletes these. An archive built
 *      over months vanishes with no error and nothing to explain it.
 *   2. It is a cloud-synced folder. Dropbox, iCloud Drive, OneDrive and Google Drive copy
 *      every file to a third party. That silently breaks the promise the README makes.
 *   3. It is a system location the tool has no business writing to.
 *
 * Refusals are hard errors. Warnings are shown to the person and can be accepted, because
 * "I keep my photos in Dropbox on purpose" is a legitimate choice — it just must not be an
 * accident.
 */

export interface PathVerdict {
  ok: boolean;
  /** Set when the path is refused outright. */
  error?: string;
  /** Set when the path is allowed but the person should know something. */
  warning?: string;
  resolved: string;
}

/**
 * Matched against the resolved path with every separator turned into `/`, so one list
 * serves both `~/Dropbox/Kids` and `C:\Users\Sam\Dropbox\Kids`. Order matters: OneDrive
 * comes before Desktop/Documents because Windows moves those two folders inside OneDrive
 * when "Known Folder Move" is on, and the more specific name is the more useful warning.
 */
const SYNC_MARKERS: [RegExp, string][] = [
  [/\/Library\/Mobile Documents\//i, 'iCloud Drive'],
  [/(^|\/)iCloudDrive(\/|$)/i, 'iCloud Drive'],
  [/\/Library\/CloudStorage\//i, 'a cloud storage service'],
  [/(^|\/)Dropbox(\/|$)/i, 'Dropbox'],
  [/(^|\/)OneDrive[^/]*(\/|$)/i, 'OneDrive'],
  [/(^|\/)(Google Drive|My Drive)(\/|$)/i, 'Google Drive'],
  [/(^|\/)(Desktop|Documents)(\/|$)/i, 'your Desktop or Documents folder, which macOS and Windows often sync to iCloud Drive or OneDrive'],
];

export interface CheckOptions {
  /**
   * Permit a temporary directory. Used ONLY by the test suite, which archives into
   * mkdtemp() and must still exercise the real validator rather than a weakened copy of
   * it. No production call site passes this.
   */
  allowTemporary?: boolean;
  /**
   * Judge the path by another operating system's rules, with that system's home, temp
   * and environment. Also test-only: the Windows rules below were written on a Mac and
   * first run for real in CI, so the suite has to be able to exercise `C:\Windows\Temp`
   * on a machine that has no such thing. Production call sites pass none of these and
   * get the machine the tool is running on.
   */
  platform?: NodeJS.Platform;
  homedir?: string;
  tmpdir?: string;
  env?: Record<string, string | undefined>;
  /**
   * The tool's own config folders, which no archive may be inside or hold. Test-only, like
   * the options above; production call sites pass none and get configDir(), and the
   * pre-rename folder when it is there, whenever the path is judged for the machine it is on.
   */
  configDirs?: string[];
}

/**
 * Where a path really is: every symbolic link in it followed, as far down as it exists. The
 * nearest folder on the way up that exists is resolved, and what is below it — which cannot
 * be a link, since it does not exist yet — is put back on. Null when nothing on the way up
 * can be resolved.
 */
function realSpelling(target: string, p: path.PlatformPath): string | null {
  const below: string[] = [];
  let probe = target;
  for (;;) {
    try {
      const found = realpathSync.native(probe);
      return below.length === 0 ? found : p.join(found, ...below.reverse());
    } catch {
      const parent = p.dirname(probe);
      if (parent === probe) return null;
      below.push(p.basename(probe));
      probe = parent;
    }
  }
}

export function checkArchiveDir(input: string, options: CheckOptions = {}): PathVerdict {
  const platform = options.platform ?? osPlatform();
  const windows = platform === 'win32';
  // The path module for the platform being judged, not the one this process runs on.
  const p = windows ? path.win32 : path.posix;
  // Only a path judged for the machine this runs on has a disk to look at: a Windows path
  // judged on a Mac, for a test, is words.
  const local = platform === osPlatform();
  const home = options.homedir ?? osHomedir();
  const env = options.env ?? process.env;

  // Windows filesystems ignore case, so `c:\windows` and `C:\Windows` are the same place.
  const canon = (s: string): string => (windows ? p.resolve(s).toLowerCase() : p.resolve(s));
  /** True when `child` is inside `parent` (or is it), compared on resolved paths. */
  const isInside = (child: string, parent: string): boolean => {
    const a = canon(child);
    const b = canon(parent);
    return a === b || a.startsWith(b.endsWith(p.sep) ? b : b + p.sep);
  };
  /**
   * A place as typed, and — on this machine — where it really is, when that differs
   * (security review fs-11). Every rule below is applied to both, and every place it names is
   * spelled both ways too: a link in the home folder to /tmp is a temporary folder, and so is
   * /private/var/folders on a Mac, which is where /var/folders really is.
   */
  const spellings = (s: string): string[] => {
    const typed = p.resolve(s);
    const real = local ? realSpelling(typed, p) : null;
    return real !== null && canon(real) !== canon(typed) ? [typed, real] : [typed];
  };
  const within = (where: string[], place: string): boolean => {
    const places = spellings(place);
    return where.some((w) => places.some((q) => isInside(w, q)));
  };

  const raw = (input ?? '').trim();
  // Only a bare `~` or a `~/` prefix means the home folder. `~sam` means another user's
  // home on POSIX, which is nothing this tool should guess at.
  const expanded = raw === '~' || /^~[/\\]/.test(raw) ? p.join(home, raw.slice(2)) : raw;
  const resolved = p.resolve(expanded);

  if (!raw) {
    return { ok: false, error: 'Please choose a folder to save the photos in.', resolved };
  }
  const where = spellings(resolved);

  // Where Windows keeps the operating system. `SystemRoot` is the authoritative answer;
  // the literal is for a process started with a scrubbed environment.
  const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows';
  const systemDrive = p.parse(systemRoot).root;

  // 1 — temporary directories. The operating system empties these.
  const temps = options.allowTemporary
    ? []
    : windows
      ? [options.tmpdir ?? osTmpdir(), p.join(systemRoot, 'Temp'), ...(env.LOCALAPPDATA ? [p.join(env.LOCALAPPDATA, 'Temp')] : [])]
      : [options.tmpdir ?? osTmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders'];
  for (const t of temps) {
    if (within(where, t)) {
      return {
        ok: false,
        error:
          `That is a temporary folder, and your computer deletes those automatically — ` +
          `your photos would disappear without warning. Please choose somewhere permanent, ` +
          `such as ${p.join(home, 'Care Album Photos')}.`,
        resolved,
      };
    }
  }

  // 2 — system locations.
  const forbidden = windows
    ? [
        systemRoot,
        env.ProgramFiles || p.join(systemDrive, 'Program Files'),
        env['ProgramFiles(x86)'] || p.join(systemDrive, 'Program Files (x86)'),
      ]
    : ['/System', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/Library/Caches'];
  for (const f of forbidden) {
    if (within(where, f)) {
      return { ok: false, error: 'That folder belongs to your operating system. Please choose somewhere in your home folder.', resolved };
    }
  }
  // The root of a drive: `/`, `C:\`, or a bare network share. `parse().root` is the whole
  // path exactly when there is nothing below the root.
  const homes = spellings(home);
  if (where.some((w) => p.parse(w).root === w || homes.some((h) => canon(w) === canon(h)))) {
    return { ok: false, error: 'Please choose a folder of its own, not your whole home folder or drive.', resolved };
  }

  // 2b — the tool's own config folder (security review fs-11), where the saved sign-in is:
  // neither inside it nor holding it — its parent, say, `~/Library/Application Support`. An
  // archive holding it would have the folder check list the session file as a photo the
  // list is missing, and the repair write it into the list, from where the page would serve it.
  const own = options.configDirs ?? (local ? [configDir(), legacyConfigDir()].filter((d): d is string => d !== null) : []);
  for (const dir of own) {
    const dirs = spellings(dir);
    if (within(where, dir) || dirs.some((d) => where.some((w) => isInside(d, w)))) {
      return {
        ok: false,
        error:
          'That folder is, or holds, the one where Care Album Saver keeps its settings and your saved sign-in, ' +
          `and your photos must be kept apart from those. Please choose a folder of its own, such as ${p.join(home, 'Care Album Photos')}.`,
        resolved,
      };
    }
  }

  // 3 — cloud-synced folders. Allowed, but never by accident; and a link from a plain
  // folder into one is a cloud-synced folder too. The spelling as typed is read first, as
  // it names the service the parent knows it by: ~/Dropbox is a link into
  // ~/Library/CloudStorage on a Mac, and "Dropbox" says more than "a cloud storage service".
  for (const spelling of where) {
    const slashed = spelling.split(p.sep).join('/');
    const marker = SYNC_MARKERS.find(([pattern]) => pattern.test(slashed));
    if (marker) {
      return {
        ok: true,
        warning:
          `This folder looks like it is inside ${marker[1]}. If it is, a copy of every photo ` +
          `will be uploaded there. That is fine if you meant it — just be aware it is no ` +
          `longer only on this computer.`,
        resolved,
      };
    }
  }

  return { ok: true, resolved };
}

/**
 * Permissions for the archive itself.
 *
 * 0700: owner only. The photos are of a child, and the archive identifies them whatever the
 * names switch says — the folder is named for the child, the .json file beside each photo
 * carries the child, the nursery and the teacher, and archive.json carries all of it for
 * the whole archive. Turning the names off keeps them out of the photo you might share; it
 * does not make the archive anonymous, and this mode is what protects it from other
 * accounts on a shared family computer. Windows ignores the mode and inherits the parent
 * ACL instead; the README says so rather than implying otherwise.
 */
export const ARCHIVE_DIR_MODE = 0o700;
