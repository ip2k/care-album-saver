import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which copy of the tool this is.
 *
 *  - production: the copy scripts/deploy.js put in place — a clone kept on main, built and
 *    tested there, which runs the real daily job and the real setup page. It carries an
 *    untracked marker file.
 *  - development: any other git checkout or worktree, where branches are built and changed.
 *  - installed: neither — a copy installed some other way, which is nobody's development
 *    copy and is left to behave as it always has.
 *
 * The distinction exists because the daily run once pointed at the development checkout,
 * so each build of a branch in progress went live at the next scheduled run.
 */
export type Environment = 'production' | 'development' | 'installed';

/** This package's repository root: dist/ → the package → packages/ → the root. */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const PRODUCTION_MARKER = '.care-album-saver-production';

export function environment(root: string = ROOT): Environment {
  if (existsSync(join(root, PRODUCTION_MARKER))) return 'production';
  if (existsSync(join(root, '.git'))) return 'development';
  return 'installed';
}

/** Why a development copy does not set up the daily run, in a sentence a person can act on. */
export const DEVELOPMENT_SCHEDULE_REFUSAL =
  'This is a development copy of the tool, so it does not set up the daily run: the daily run ' +
  'should run the tested copy on main. Run `node scripts/deploy.js`, which puts main into ' +
  'production and moves the daily run there.';
