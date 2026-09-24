import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { writeAtomically } from './ferry/index.js';

/**
 * Where configuration and the saved session live.
 *
 * This is the single most important security decision in the project, and it is a
 * *structural* one: the session file lives in the operating system's per-user config
 * directory, never inside the project folder. Someone who clones this repository has
 * nothing in the working tree that could be committed, because there is nothing there.
 *
 * This is why the project does not use a `.env` file in the repo, which is the usual Node
 * convention. A `.env` sits one `git add -A` away from a public commit, and the people
 * using this tool are not practised at spotting that. Making the bad state unrepresentable
 * beats warning people about it.
 *
 * Resolved without a dependency (`env-paths` would do this, but zero deps is a stronger
 * supply-chain posture for software that handles children's photos).
 */
export function configDir(): string {
  const home = homedir();
  const env = process.env;
  // The old spelling is still honoured, and deliberately first-come: a script, a launchd
  // job or a shell profile written before the rename must not silently start pointing at
  // a different directory than the one it has been isolating all along.
  if (env.CARE_ALBUM_CONFIG_DIR) return env.CARE_ALBUM_CONFIG_DIR;
  if (env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR) return env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR;

  const parent = platform() === 'darwin'
    ? join(home, 'Library', 'Application Support')
    : platform() === 'win32'
      ? env.APPDATA || join(home, 'AppData', 'Roaming')
      : env.XDG_CONFIG_HOME || join(home, '.config');

  // The project was called brightwheel-archive until 2026-09-22. Someone who set the tool
  // up before then has their session in a directory of that name, and a rename that
  // orphaned it would look exactly like being signed out for no reason — on a tool whose
  // one manual step is signing in again. So: the new directory if it exists, the old one
  // if only that does, and the new one when there is neither (a first run). Nothing is
  // moved or deleted here; the next save writes wherever this points.
  const current = join(parent, 'care-album-saver');
  if (existsSync(current)) return current;
  const legacy = join(parent, 'brightwheel-archive');
  if (existsSync(legacy)) return legacy;
  return current;
}

/** Where the pre-rename configuration lived, for `doctor` to mention if it is still there. */
export function legacyConfigDir(): string | null {
  const home = homedir();
  const env = process.env;
  const parent = platform() === 'darwin'
    ? join(home, 'Library', 'Application Support')
    : platform() === 'win32'
      ? env.APPDATA || join(home, 'AppData', 'Roaming')
      : env.XDG_CONFIG_HOME || join(home, '.config');
  const legacy = join(parent, 'brightwheel-archive');
  return existsSync(legacy) ? legacy : null;
}

export const configPath = (): string => join(configDir(), 'config.json');
export const sessionPath = (): string => join(configDir(), 'session.json');

/** Default place to put the photos, if the user does not choose one. */
export function defaultArchiveDir(): string {
  // The override exists for the same reason CARE_ALBUM_CONFIG_DIR does, and it was
  // added for the same reason: isolating the config directory was not enough. A test or an
  // ad-hoc script that builds a config from DEFAULT_CONFIG without naming a folder archives
  // into the real one — which put mock photographs in a developer's home directory three
  // times on 2026-09-22, each time from code that believed it was isolated. The test run
  // sets this (see scripts/test-env.js); nothing in the product does.
  const override = process.env.CARE_ALBUM_DIR || process.env.BRIGHTWHEEL_ARCHIVE_DIR;
  if (override) return override;
  // A folder this tool creates should not be named after somebody else's service, and the
  // project may grow to read more than one. But an archive already sitting in the old
  // folder is a year of a child's photographs, so it is never renamed: if it is there and
  // the new one is not, it stays the default. A person who has run the tool before has the
  // path written in their config.json in any case, which wins over this entirely.
  const legacy = join(homedir(), 'Brightwheel Photos');
  const current = join(homedir(), 'Care Album Photos');
  if (!existsSync(current) && existsSync(legacy)) return legacy;
  return current;
}

/**
 * Write a file containing secrets with owner-only permissions.
 *
 * The mode is set on the temporary file before the secret is written into it, never
 * afterwards: doing it in two steps leaves a window — however short — in which the file
 * exists and is readable by every account on the machine. On a shared family computer that
 * window is the whole threat. The temporary file's name is unpredictable and never opened
 * through a symlink; see writeAtomically.
 *
 * Windows ignores POSIX modes. There, the file inherits the ACL of the per-user AppData
 * directory, which already excludes other standard users. That is weaker than 0600 but it
 * is what the platform offers without a native dependency; the README says so plainly
 * rather than implying a protection we do not provide.
 */
export async function writeSecureFile(path: string, contents: string): Promise<void> {
  const folder = join(path, '..');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if (resolve(folder) === resolve(configDir())) await makeOwnerOnly(folder);
  await writeAtomically(path, contents, 0o600);
}

/**
 * Make the config folder owner-only when it is not already (security review docs-9).
 *
 * `mkdir`'s mode applies only to a folder it creates. One that was there first keeps its own:
 * a folder made by hand, one named by CARE_ALBUM_CONFIG_DIR, or the image's /config, which
 * the Dockerfile makes at the default 755. Every file the tool writes into it is 0600 all the
 * same, so its contents are safe either way; what a 755 folder gives away is the names — that
 * there is a session.json, a photos.json, a last-run.json — and room for someone else to
 * stand beside them. So the folder is narrowed to its owner's bits, the same treatment sync
 * gives the photos folder (ensureOwnerOnly in sync.ts), but only:
 *
 *  - when this account owns it. Someone else's folder, a root-owned bind mount for instance,
 *    cannot be changed by this account and is not this tool's to change; it is left as it is.
 *  - never wider. A folder already stricter than 0700 is left alone.
 *  - never the home folder, should the config folder ever be pointed there: that would take
 *    away what other accounts are meant to reach in it, macOS's Public folder among them.
 *
 * Anything that stops it — a folder it does not own, a file system without POSIX modes, a
 * refusal — leaves the folder as it was and the file is still written 0600; the session is
 * not held back over the folder's mode. Windows has no POSIX modes, as in writeSecureFile.
 */
async function makeOwnerOnly(folder: string): Promise<void> {
  if (platform() === 'win32' || typeof process.getuid !== 'function') return;
  if (resolve(folder) === resolve(homedir())) return;
  try {
    const { mode, uid } = await stat(folder);
    if (uid !== process.getuid() || (mode & 0o077) === 0) return;
    await chmod(folder, mode & 0o700);
  } catch {
    /* Left as it was; see above. */
  }
}

/**
 * One of this tool's own files that is there but cannot be read back.
 *
 * Kept apart from "it is not there" on purpose. The two used to be the same `null`, so a
 * `config.json` damaged by a full disk or a hand edit read exactly like a first run: the
 * daily job forgot which folder the photos were in and which children to save, made the
 * default folder and downloaded every child's whole feed into it (security review fs-5).
 * Each caller decides what a damaged file means for it; none may take it for a fresh start
 * without saying so.
 */
export class UnreadableFileError extends Error {
  constructor(public readonly path: string, public readonly reason: string) {
    super(`${path} cannot be read: ${reason}.`);
    this.name = 'UnreadableFileError';
  }
}

/** Why a file that is there could not be read, in words, for the errors people actually meet. */
const UNREADABLE: Record<string, string> = {
  EACCES: 'this account is not allowed to read it',
  EPERM: 'this account is not allowed to read it',
  EISDIR: 'it is a folder, not a file',
  ELOOP: 'it is a link that leads round in a circle',
  EIO: 'the disk it is on could not be read',
};

/** Read one of this tool's JSON files: `null` only when it does not exist. See UnreadableFileError. */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new UnreadableFileError(path, UNREADABLE[code ?? ''] ?? `it could not be opened (${code ?? String(error)})`);
  }
  let parsed: unknown;
  try {
    // A byte-order mark is what Notepad and some other Windows editors put at the start of a
    // file they save as UTF-8. The JSON after it is fine, and JSON.parse is the only thing
    // that minds.
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    // Not the parser's message: it can quote the file's contents, and this one holds a session.
    throw new UnreadableFileError(path, 'it is not valid JSON');
  }
  // `null` is this function's "not there", so a file that says only `null` cannot be let
  // through as one: it is there, and it holds nothing this tool wrote.
  if (parsed === null) throw new UnreadableFileError(path, 'it does not contain anything');
  return parsed as T;
}
