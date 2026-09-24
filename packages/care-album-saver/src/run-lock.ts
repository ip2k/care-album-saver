import { open, readFile, rm, stat, utimes } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

/**
 * One run at a time per archive folder, across processes.
 *
 * The daily run, the setup page and the command line are separate processes, and before this
 * nothing stopped two of them saving into the same folder at once. Turning the daily run on
 * starts one straight away (launchd's RunAtLoad, for the missed-run catch-up), so pressing
 * "Save new photos" in the same minute was enough. Both runs then write archive.json, the
 * later save replaces the earlier one's records, and photos that are on disk stop being
 * listed — so the next run fetches them again, as "-2" copies.
 *
 * The lock is a file in the archive folder, created with O_EXCL ('wx') so that exactly one
 * process can create it, holding who took it and when. A run that finds it held stops before
 * reading the list or fetching anything. A lock whose owner is gone is taken over: on this
 * computer, when its process no longer exists; from anywhere, when it has not been touched
 * for STALE_MS — a running sync touches it as it goes, so only a run that died looks that old.
 */

export const RUN_LOCK_FILENAME = '.care-album-saver.lock';

/** How long a lock may go untouched before it is presumed abandoned. */
const STALE_MS = 30 * 60 * 1000;

/** How often a running sync refreshes the lock's time. */
const TOUCH_EVERY_MS = 60 * 1000;

export interface RunLockHolder {
  pid: number;
  host: string;
  startedAt: string;
}

/** Thrown by `sync` when another run holds the folder. Not a failure; nothing was changed. */
export class RunInProgressError extends Error {
  constructor(readonly holder: RunLockHolder | null) {
    const since = holder && !Number.isNaN(Date.parse(holder.startedAt))
      ? ` (it started at ${new Date(holder.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })})`
      : '';
    super(
      `Another run is already saving photos into this folder${since}. This one did not start, so the ` +
        'two cannot get in each other’s way, and nothing was changed.',
    );
    this.name = 'RunInProgressError';
  }
}

export interface RunLock {
  /** Refresh the lock's time, at most once a minute however often it is called. */
  touch(): void;
  /** Remove the lock, if it is still this run's. */
  release(): Promise<void>;
}

/** Whether a process with this id exists on this computer. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is just not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readHolder(file: string): Promise<RunLockHolder | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<RunLockHolder>;
    if (typeof parsed.pid !== 'number' || typeof parsed.host !== 'string' || typeof parsed.startedAt !== 'string') return null;
    return { pid: parsed.pid, host: parsed.host, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

/**
 * Take the folder's lock, or throw RunInProgressError. `now` and `isAlive` are for the tests.
 */
export async function takeRunLock(
  root: string,
  options: { now?: () => number; isAlive?: (pid: number) => boolean } = {},
): Promise<RunLock> {
  const file = join(root, RUN_LOCK_FILENAME);
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? alive;
  const me: RunLockHolder = { pid: process.pid, host: hostname(), startedAt: new Date(now()).toISOString() };

  // Twice at most: once, and once more after clearing a lock whose owner is gone.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(me));
      await handle.close();
      return held(file, me, now);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = await readHolder(file);
    const touched = await stat(file).then((s) => s.mtimeMs, () => null);
    // Gone between the two calls: its run just finished, so try again at once.
    if (touched === null) continue;
    // An unreadable lock is NOT abandoned: the file exists, empty, for the instant between
    // its owner creating it and writing to it, and reading it in that instant must not be
    // taken as licence to delete it. Only age decides for one of those.
    const abandoned =
      now() - touched > STALE_MS ||
      (holder !== null && holder.host === me.host && !isAlive(holder.pid));
    if (!abandoned) throw new RunInProgressError(holder);
    await rm(file, { force: true });
  }
  throw new RunInProgressError(await readHolder(file));
}

function held(file: string, me: RunLockHolder, now: () => number): RunLock {
  let lastTouch = now();
  return {
    touch() {
      if (now() - lastTouch < TOUCH_EVERY_MS) return;
      lastTouch = now();
      const t = new Date(lastTouch);
      utimes(file, t, t).catch(() => {});
    },
    async release() {
      // Only our own: a lock taken over after this run was presumed dead belongs to the
      // run that took it, and removing it would let a third run in beside that one.
      const holder = await readHolder(file);
      if (holder && holder.pid === me.pid && holder.host === me.host && holder.startedAt === me.startedAt) {
        await rm(file, { force: true });
      }
    },
  };
}
