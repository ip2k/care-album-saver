import { randomBytes } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
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
 * file and restricting it at which the name could be swapped. The final `rename` replaces a
 * symlink at the target rather than following it.
 *
 * `mode` is enforced exactly, whatever the umask, and set before a byte of `data` is written.
 * Leave it out for an ordinary file (0666 less the umask, as `writeFile` would make it).
 * Windows has no POSIX modes; there the file inherits its folder's ACL, as before.
 */
export async function writeAtomically(path: string, data: string, mode?: number): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temp, 'wx', mode ?? 0o666);
  try {
    try {
      // Re-asserted on the handle: the create mode is filtered by the process umask.
      if (mode !== undefined && process.platform !== 'win32') await handle.chmod(mode);
      await handle.writeFile(data, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}
