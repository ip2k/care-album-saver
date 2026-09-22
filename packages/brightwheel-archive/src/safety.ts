import { homedir, tmpdir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

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

const SYNC_MARKERS: [RegExp, string][] = [
  [/\/Library\/Mobile Documents\//i, 'iCloud Drive'],
  [/\/Library\/CloudStorage\//i, 'a cloud storage service'],
  [/(^|\/)Dropbox(\/|$)/i, 'Dropbox'],
  [/(^|\/)OneDrive[^/]*(\/|$)/i, 'OneDrive'],
  [/(^|\/)Google Drive(\/|$)/i, 'Google Drive'],
  [/(^|\/)(Desktop|Documents)(\/|$)/i, 'a folder macOS often syncs to iCloud'],
];

/** True when `child` is inside `parent` (or is it), compared on resolved paths. */
function isInside(child: string, parent: string): boolean {
  const a = resolve(child);
  const b = resolve(parent);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

export interface CheckOptions {
  /**
   * Permit a temporary directory. Used ONLY by the test suite, which archives into
   * mkdtemp() and must still exercise the real validator rather than a weakened copy of
   * it. No production call site passes this.
   */
  allowTemporary?: boolean;
}

export function checkArchiveDir(input: string, options: CheckOptions = {}): PathVerdict {
  const raw = (input ?? '').trim();
  const resolved = raw.startsWith('~') ? resolve(homedir(), raw.slice(1).replace(/^[/\\]/, '')) : resolve(raw);

  if (!raw) {
    return { ok: false, error: 'Please choose a folder to save the photos in.', resolved };
  }
  if (!isAbsolute(resolved)) {
    return { ok: false, error: 'Please give a full path, starting from the top of your drive.', resolved };
  }

  // 1 — temporary directories. The operating system empties these.
  const temps = options.allowTemporary
    ? []
    : [tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders'];
  for (const t of temps) {
    if (isInside(resolved, t)) {
      return {
        ok: false,
        error:
          `That is a temporary folder, and your computer deletes those automatically — ` +
          `your photos would disappear without warning. Please choose somewhere permanent, ` +
          `such as ${resolve(homedir(), 'Brightwheel Photos')}.`,
        resolved,
      };
    }
  }

  // 2 — system locations.
  for (const forbidden of ['/System', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/Library/Caches']) {
    if (isInside(resolved, forbidden)) {
      return { ok: false, error: 'That folder belongs to your operating system. Please choose somewhere in your home folder.', resolved };
    }
  }
  if (resolved === '/' || resolved === homedir()) {
    return { ok: false, error: 'Please choose a folder of its own, not your whole home folder or drive.', resolved };
  }

  // 3 — cloud-synced folders. Allowed, but never by accident.
  for (const [pattern, name] of SYNC_MARKERS) {
    if (pattern.test(resolved)) {
      return {
        ok: true,
        warning:
          `This folder looks like it is inside ${name}. If it is, a copy of every photo ` +
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
 * 0700: owner only. The photos are of a child and, because this tool writes the child's
 * name into the metadata of every file, they are identified photographs. They should not be
 * readable by other accounts on a shared family computer. Windows ignores the mode and
 * inherits the parent ACL instead; the README says so rather than implying otherwise.
 */
export const ARCHIVE_DIR_MODE = 0o700;
