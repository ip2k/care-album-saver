import { copyRootFrom } from './package-root.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { environment } from './environment.js';

/**
 * Which version of the tool this is, and how it came to be on this computer.
 *
 * The version is the package's own. The commit is read from the checkout's .git folder
 * directly — HEAD, then the branch it names, loose or packed — so that a copy built from a
 * clone can say exactly what it is running without starting a git process, and a copy
 * installed any other way, which has no .git, simply has none.
 */

/** This package: dist/ → the package. */
const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));
/**
 * The repository root, for a copy built from a clone; the package itself otherwise, which has
 * no .git, so an npm install inside someone's git project is not read as a clone (processes-9).
 */
const REPO_ROOT = copyRootFrom(fileURLToPath(new URL('./', import.meta.url)));

export interface VersionInfo {
  /** From package.json, e.g. "0.1.0". */
  version: string;
  /** The commit a clone is on, abbreviated to seven characters; null outside a clone. */
  commit: string | null;
}

export function currentVersion(packageDir: string = PACKAGE_DIR, repoRoot: string = REPO_ROOT): VersionInfo {
  let version = '0.0.0';
  try {
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string') version = pkg.version;
  } catch {
    /* A package with no readable package.json reports 0.0.0, which any release is newer than. */
  }
  return { version, commit: readCommit(repoRoot) };
}

const SHA = /^[0-9a-f]{40}$/;

/** The commit a checkout is on, or null. Never throws, and never runs git. */
export function readCommit(root: string): string | null {
  try {
    let gitDir = join(root, '.git');
    // A worktree's .git is a file naming the real one.
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'))?.[1]?.trim();
      if (!pointer) return null;
      gitDir = isAbsolute(pointer) ? pointer : resolve(root, pointer);
    }
    // Branches live in the common directory, which for a worktree is not its own.
    let common = gitDir;
    if (existsSync(join(gitDir, 'commondir'))) {
      common = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (SHA.test(head)) return head.slice(0, 7);
    const ref = /^ref:\s*(refs\/\S+)$/.exec(head)?.[1];
    if (!ref || ref.includes('..')) return null;
    for (const dir of [gitDir, common]) {
      const loose = join(dir, ...ref.split('/'));
      if (existsSync(loose)) {
        const sha = readFileSync(loose, 'utf8').trim();
        return SHA.test(sha) ? sha.slice(0, 7) : null;
      }
    }
    const packed = readFileSync(join(common, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
    const sha = line?.split(' ')[0] ?? '';
    return SHA.test(sha) ? sha.slice(0, 7) : null;
  } catch {
    return null;
  }
}

/**
 * How this copy was installed, which decides what "how to update" says. Worked out from
 * where the package's own files are, since every installer puts them somewhere
 * recognisable, and nothing is asked of the network or of another program.
 *
 *  - production   the owner's deployed clone (scripts/deploy.js): deploy again.
 *  - docker       in a container: rebuild the image from an updated clone.
 *  - git          a clone, as the README describes: git pull, then build.
 *  - download     the repository's files without .git, from a ZIP or a release archive.
 *  - npm-global, pnpm-global, yarn-global, bun-global
 *                 installed globally with that package manager: install @latest.
 *  - npm-local    a dependency of some other project: update it there.
 *  - npx, pnpm-dlx, yarn-dlx, bunx
 *                 run from a package manager's cache: run it again as @latest.
 *  - unknown      none of those; the page links to every way rather than guessing.
 */
export type InstallKind =
  | 'production'
  | 'docker'
  | 'git'
  | 'download'
  | 'npm-global'
  | 'pnpm-global'
  | 'yarn-global'
  | 'bun-global'
  | 'npm-local'
  | 'npx'
  | 'pnpm-dlx'
  | 'yarn-dlx'
  | 'bunx'
  | 'unknown';

export function installKind(
  options: { packageDir?: string; repoRoot?: string; inContainer?: boolean; separator?: string } = {},
): InstallKind {
  const packageDir = options.packageDir ?? PACKAGE_DIR;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  if (environment(repoRoot) === 'production') return 'production';
  if (options.inContainer ?? (existsSync('/.dockerenv') || existsSync('/run/.containerenv'))) return 'docker';

  // Checked before .git: a package installed inside somebody's own project finds that
  // project's .git three folders up, and is not a clone of this one.
  const parts = packageDir.split(options.separator ?? sep).filter(Boolean);
  const has = (...run: string[]): boolean =>
    parts.some((_, i) => run.every((segment, j) => parts[i + j] === segment));
  if (parts.includes('_npx')) return 'npx';
  if (parts.some((p) => p.startsWith('bunx-'))) return 'bunx';
  if (has('pnpm', 'dlx') || (parts.includes('dlx') && parts.some((p) => p.startsWith('pnpm')))) return 'pnpm-dlx';
  if (parts.some((p) => p.startsWith('dlx-') || p.startsWith('xfs-'))) return 'yarn-dlx';
  const nm = parts.lastIndexOf('node_modules');
  if (nm >= 0) {
    if (has('.bun', 'install', 'global')) return 'bun-global';
    if (has('pnpm', 'global') || has('pnpm-global')) return 'pnpm-global';
    if (has('yarn', 'global') || has('Yarn', 'Data', 'global') || has('.yarn-global')) return 'yarn-global';
    // npm's global folder is lib/node_modules on macOS and Linux (Homebrew, nvm, a custom
    // prefix alike) and npm/node_modules on Windows.
    const above = parts[nm - 1];
    return above === 'lib' || above === 'npm' ? 'npm-global' : 'npm-local';
  }
  if (existsSync(join(repoRoot, '.git'))) return 'git';
  if (existsSync(join(repoRoot, 'pnpm-workspace.yaml'))) return 'download';
  return 'unknown';
}

/**
 * The clone a deployed production copy was made from, which is where it is updated: deploy.js
 * clones production from the development checkout, so that checkout is production's origin.
 * Read from .git/config; null when there is none.
 */
export function productionSource(repoRoot: string = REPO_ROOT): string | null {
  try {
    const config = readFileSync(join(repoRoot, '.git', 'config'), 'utf8');
    const origin = /\[remote "origin"\][^[]*?\burl\s*=\s*(.+)/.exec(config)?.[1]?.trim();
    return origin && isAbsolute(origin) ? origin : null;
  } catch {
    return null;
  }
}

/** Where a clone lives, for the commands that update it. */
export const repositoryRoot = (): string => REPO_ROOT;
