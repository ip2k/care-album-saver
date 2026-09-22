import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';

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
  if (env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR) return env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR;

  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'brightwheel-archive');
    case 'win32':
      return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'brightwheel-archive');
    default:
      return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'brightwheel-archive');
  }
}

export const configPath = (): string => join(configDir(), 'config.json');
export const sessionPath = (): string => join(configDir(), 'session.json');

/** Default place to put the photos, if the user does not choose one. */
export function defaultArchiveDir(): string {
  // The override exists for the same reason BRIGHTWHEEL_ARCHIVE_CONFIG_DIR does, and it was
  // added for the same reason: isolating the config directory was not enough. A test or an
  // ad-hoc script that builds a config from DEFAULT_CONFIG without naming a folder archives
  // into the real one — which put mock photographs in a developer's home directory three
  // times on 2026-09-22, each time from code that believed it was isolated. The test run
  // sets this (see scripts/test-env.js); nothing in the product does.
  return process.env.BRIGHTWHEEL_ARCHIVE_DIR || join(homedir(), 'Brightwheel Photos');
}

/**
 * Write a file containing secrets with owner-only permissions.
 *
 * The mode is passed to `writeFile` rather than applied afterwards with `chmod`. Doing it
 * in two steps leaves a window — however short — in which the file exists and is readable
 * by every account on the machine. On a shared family computer that window is the whole
 * threat.
 *
 * Windows ignores POSIX modes. There, the file inherits the ACL of the per-user AppData
 * directory, which already excludes other standard users. That is weaker than 0600 but it
 * is what the platform offers without a native dependency; the README says so plainly
 * rather than implying a protection we do not provide.
 */
export async function writeSecureFile(path: string, contents: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  await writeFile(temp, contents, { encoding: 'utf8', mode: 0o600, flag: 'w' });
  if (platform() !== 'win32') {
    // Re-assert in case a permissive umask altered the create mode.
    await chmod(temp, 0o600);
  }
  await rename(temp, path);
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}
