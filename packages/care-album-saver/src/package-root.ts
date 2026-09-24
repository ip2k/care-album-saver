import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** This tool's package name, in its own package.json and in the repository's. */
export const PACKAGE_NAME = 'care-album-saver';

/** The nearest folder at or above `from` holding a package.json, and the name in it. */
function nearestManifest(from: string): { dir: string; name: unknown } | null {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        return { dir, name: (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown } | null)?.name };
      } catch {
        return { dir, name: undefined };
      }
    }
    if (dirname(dir) === dir) return null;
  }
}

/**
 * The folder a copy of the tool is, found from a folder inside it (`dist/`, say): the
 * repository's root in a clone, the package itself in an npm install.
 *
 * Found by walking up to this package — the nearest package.json, which must be named
 * care-album-saver — and then to the next package.json above that: the repository's own, of
 * the same name, in a clone; anything else (an npm install inside someone's project, say)
 * means the package is the copy. It was three folders up from `dist/`, counted (security
 * review processes-9), which holds only in a clone: in an npm install three folders up is the
 * folder holding node_modules, someone else's project, and a clone of theirs would have been
 * read as this tool's own. It also held only while the build wrote into a folder exactly one
 * below the package. Anything not in this package at all is a copy of its own folder.
 */
export function copyRootFrom(from: string): string {
  const pkg = nearestManifest(from);
  if (!pkg || pkg.name !== PACKAGE_NAME) return resolve(from);
  const above = dirname(pkg.dir) === pkg.dir ? null : nearestManifest(dirname(pkg.dir));
  return above?.name === PACKAGE_NAME ? above.dir : pkg.dir;
}
