import { copyRootFrom } from './package-root.js';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which copy of the tool this is.
 *
 *  - production: the copy scripts/deploy.js put in place — a clone kept on main, built and
 *    tested there, which runs the real daily job and the real setup page. It carries an
 *    untracked marker file at its root.
 *  - development: the checkout deploy.js deploys from, and every worktree of it, where
 *    branches are built and changed. deploy.js marks it inside git's own folder, which git
 *    never commits or pushes and every worktree of the checkout shares.
 *  - installed: anything else — the clone the README tells a parent to make, an npm install,
 *    a container. This is somebody's real copy, and it behaves as one.
 *
 * The distinction exists because the daily run once pointed at the development checkout, so
 * each build of a branch in progress went live at the next scheduled run. It was first drawn
 * as "any checkout with a .git is development", which also refused the daily run to every
 * parent who followed the README; development has to be marked, because only the developer's
 * machine knows it is one.
 */
export type Environment = 'production' | 'development' | 'installed';

/** This copy of the tool: the repository's root in a clone, the package in an npm install. */
const ROOT = copyRootFrom(fileURLToPath(new URL('./', import.meta.url)));
export const PRODUCTION_MARKER = '.care-album-saver-production';
/** Inside the repository's common git directory, never in the working tree. */
export const DEVELOPMENT_MARKER = 'care-album-saver-development';

export function environment(root: string = ROOT): Environment {
  if (isProductionRoot(root)) return 'production';
  const common = gitCommonDir(root);
  if (common && existsSync(join(common, DEVELOPMENT_MARKER))) return 'development';
  return 'installed';
}

/**
 * Whether the copy at `root` is the production copy: it holds the marker, and the marker
 * names this very folder.
 *
 * The marker used to count wherever it was found, so a copy of production — a Finder
 * duplicate, a backup restored elsewhere, the old folder after deploying `--to` a new one —
 * was production too, and as production it could take the daily run from the real one
 * without asking (security review, adversarial pass). deploy.js now writes the production
 * folder's own real path on the marker's first line; a marker that names another folder, or
 * none (one written before this), does not make a copy production.
 */
export function isProductionRoot(root: string): boolean {
  try {
    const named = readFileSync(join(root, PRODUCTION_MARKER), 'utf8').split(/\r?\n/)[0]?.trim() ?? '';
    return isAbsolute(named) && realpathSync.native(named) === realpathSync.native(root);
  } catch {
    return false;
  }
}

/**
 * The folder git keeps a repository's shared state in: .git itself for an ordinary checkout,
 * and for a worktree, the main checkout's .git, which its own .git file points towards.
 */
export function gitCommonDir(root: string): string | null {
  try {
    let gitDir = join(root, '.git');
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'))?.[1]?.trim();
      if (!pointer) return null;
      gitDir = isAbsolute(pointer) ? pointer : resolve(root, pointer);
    }
    const commondir = join(gitDir, 'commondir');
    return existsSync(commondir) ? resolve(gitDir, readFileSync(commondir, 'utf8').trim()) : gitDir;
  } catch {
    return null;
  }
}

/** Why a development copy does not set up the daily run, in a sentence a person can act on. */
export const DEVELOPMENT_SCHEDULE_REFUSAL =
  'This is a development copy of the tool, so it does not set up the daily run: the daily run ' +
  'should run the tested copy on main. Run `node scripts/deploy.js`, which puts main into ' +
  'production and moves the daily run there.';
