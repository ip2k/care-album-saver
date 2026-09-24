import { lstat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/**
 * A file the archive's list names, as a real place on disk strictly inside the archive —
 * or null when it is not: an entry that climbs out with `..`, a symbolic link (refused
 * outright, whatever it points at), or anything that resolves elsewhere through a link in
 * its folders. Every consumer of archive.json that reads, hashes, deletes or hands a listed
 * file to another program goes through this, because the list can be edited by anything
 * else that can write the folder — a cloud-sync peer, another account on the computer —
 * and until 2026-09-23 the duplicate remover joined the path and deleted whatever that
 * named, inside the archive or not (found by the security review).
 */
export async function containedFile(root: string, rel: string): Promise<string | null> {
  let base: string;
  try {
    base = await realpath(resolve(root));
  } catch {
    return null;
  }
  const inside = (path: string): string | null => (path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`) ? path : null);
  const candidate = resolve(base, ...rel.split('\\').join('/').split('/'));
  try {
    if ((await lstat(candidate)).isSymbolicLink()) return null;
    return inside(await realpath(candidate));
  } catch (error) {
    // A file that is not there is the caller's to report — as missing, or as nothing to
    // remove — so its name is kept when the name alone stays inside the archive.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? inside(candidate) : null;
  }
}

/**
 * Whether every folder from the archive root down to `root/rel` is a real folder, not a link.
 *
 * The write-side partner of containedFile. Week and child folders have names anyone can work
 * out (a child's name, an ISO week), so another writer of the archive can make one of them a
 * symbolic link — or, on Windows, a junction — to a folder elsewhere before this tool gets
 * there. `mkdir` accepts the link as the folder, and everything saved "into the archive"
 * then lands in, and overwrites things in, the folder it points at (security review fs-2,
 * found by the adversarial pass). The root itself may be a link: a parent may well keep
 * their archive on another drive through one. What is below it may not.
 *
 * Component by component with lstat rather than by comparing realpaths, so that a folder
 * whose case differs from the name asked for, on a disk that ignores case, is not taken for
 * an escape. With `notYet`, a folder that does not exist yet passes — nothing below it can be
 * a link — so it can be asked before `mkdir` makes anything inside a link's target.
 */
export async function realFolderUnder(root: string, rel: string, { notYet = false } = {}): Promise<boolean> {
  let path = resolve(root);
  for (const part of rel.split('\\').join('/').split('/').filter((p) => p !== '' && p !== '.')) {
    if (part === '..') return false;
    path = resolve(path, part);
    try {
      const found = await lstat(path);
      if (found.isSymbolicLink() || !found.isDirectory()) return false;
    } catch (error) {
      return notYet && (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }
  return true;
}
