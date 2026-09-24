import { randomBytes } from 'node:crypto';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Write a file whole or not at all, through a temporary file nobody could have prepared.
 *
 * Every file this tool rewrites in place — the manifest, the settings, the session, a week
 * folder's README, a photo's `.json` sidecar — used to go through a temporary file with a
 * fixed name (`archive.json.tmp`) opened with `w`. The archive folder can have other
 * writers: a cloud-sync peer, another account with access, anything that can write a file
 * there. A symlink planted at that fixed name made the next run write through it, and the
 * `chmod` that followed made whatever it pointed at owner-only (security review fs-2).
 *
 * So the temporary name is unpredictable, and it is opened with `wx` — O_CREAT|O_EXCL, which
 * fails on any existing name, a symlink included, rather than following it. The mode is set
 * on the open handle (fchmod), never by path, so there is no moment between creating the
 * file and restricting it at which the name could be swapped. The data is synced before the
 * rename, so "whole or not at all" holds across a power cut too. The final `rename` replaces
 * a symlink at the target rather than following it.
 *
 * `mode` is enforced exactly, whatever the umask, and set before a byte of `data` is written.
 * Without one, a file being replaced keeps the mode it had — a README a parent made
 * owner-only stays owner-only — and a new file gets 0666 less the umask, as `writeFile`
 * would. Windows has no POSIX modes; there the file inherits its folder's ACL, as before.
 *
 * This covers the last name in the path only. A folder along the way that is itself a link
 * is the caller's to refuse: see `realFolderUnder` in contain.ts.
 */
export async function writeAtomically(path: string, data: string, mode?: number): Promise<void> {
  const keep = mode ?? (await existingMode(path));
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temp, 'wx', keep ?? 0o666);
  try {
    try {
      // Re-asserted on the handle: the create mode is filtered by the process umask.
      if (keep !== undefined && process.platform !== 'win32') await handle.chmod(keep);
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameOverWindowsLocks(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** The permission bits of a regular file already at `path`, or undefined when there is none. */
async function existingMode(path: string): Promise<number | undefined> {
  try {
    const found = await lstat(path);
    return found.isFile() ? found.mode & 0o777 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `rename`, retried briefly on Windows when the file being replaced is held open.
 *
 * On Windows, replacing a file that another program has open without sharing it for delete
 * fails with EPERM, EACCES or EBUSY — and antivirus scanners, the search indexer and the
 * OneDrive and Dropbox clients all open new files for a moment to look at them. An in-place
 * write never met this; a rename meets it every time a scanner is quicker than we are. So a
 * few short waits, a second in all, as graceful-fs and write-file-atomic do. Anywhere else a
 * failed rename is a real failure the first time.
 */
async function renameOverWindowsLocks(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY');
      if (!transient || attempt >= 6) throw error;
      await new Promise((r) => setTimeout(r, 20 * 2 ** attempt));
    }
  }
}
