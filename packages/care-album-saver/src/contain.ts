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
