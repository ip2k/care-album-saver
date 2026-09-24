import { open, readFile, rm, stat, utimes } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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
 * The same is true of the two pieces of upkeep that rewrite archive.json — repairing the list
 * and removing duplicate copies (maintenance.ts) — so they take this lock too, and a run and
 * one of them refuse each other in both directions (security review missed-fs and web-5).
 *
 * The lock is a file in the archive folder, created with O_EXCL ('wx') so that exactly one
 * process can create it, holding who took it, when, and for what. Whoever finds it held stops
 * before reading the list or changing anything. A holder refreshes the file's time on a timer
 * for as long as it holds it, and a lock whose owner is gone is taken over: on this computer,
 * when its process no longer exists, or when it has stopped being refreshed although a
 * process with its number does (see takeRunLock); from another computer sharing the folder,
 * when it has not been refreshed for STALE_MS.
 */

export const RUN_LOCK_FILENAME = '.care-album-saver.lock';

/** How long a lock may go unrefreshed before it is presumed abandoned. */
const STALE_MS = 30 * 60 * 1000;

/**
 * How often a holder refreshes the lock's time.
 *
 * On a timer, not on progress (security review fs-6). It used to be refreshed only when a run
 * reported progress, and a single slow download or a Retry-After wait reports none for as
 * long as it lasts: past STALE_MS the daily run read the lock as abandoned, deleted it and
 * saved into the folder beside the run that was still going.
 */
const TOUCH_EVERY_MS = 30 * 1000;

/** What a lock is held for, so whoever meets it can be told in words. */
export type RunLockPurpose = 'run' | 'repair' | 'duplicates';

export interface RunLockHolder {
  pid: number;
  host: string;
  startedAt: string;
  /** Absent in a lock written before 2026-09-23, which was always a run's. */
  purpose?: RunLockPurpose;
}

/** What the holder is doing, as the start of a sentence. */
function busyWith(holder: RunLockHolder | null, wanted: RunLockPurpose | 'check'): string {
  switch (holder?.purpose) {
    case 'repair':
      return 'The tool’s list of this folder is being repaired right now';
    case 'duplicates':
      return 'Extra copies of photos are being deleted from this folder right now';
    default:
      // A lock from before purposes were recorded, or one that cannot be read, is a run's.
      return wanted === 'run' ? 'Another run is already saving photos into this folder' : 'Photos are being saved into this folder right now';
  }
}

/** What did not happen because of it, and what to do instead. */
function whatHappened(holder: RunLockHolder | null, wanted: RunLockPurpose | 'check'): string {
  const byRun = holder?.purpose === undefined || holder.purpose === 'run';
  const later = byRun ? 'Try again when that run has finished.' : 'Try again in a minute.';
  switch (wanted) {
    case 'run':
      return byRun
        ? 'This one did not start, so the two cannot get in each other’s way, and nothing was changed.'
        : `This run did not start, so the two cannot get in each other’s way, and nothing was changed. ${later}`;
    case 'repair':
      return `The list was not repaired, so the two cannot get in each other’s way. ${later}`;
    case 'duplicates':
      return `Nothing was deleted, so the two cannot get in each other’s way. ${later}`;
    case 'check':
      return byRun
        ? 'Look again when that run has finished: until then the tool’s list of the folder is still being written, and the answer would be out of date.'
        : 'Look again in a minute.';
  }
}

/**
 * Thrown when another holder has the folder. Not a failure; nothing was changed.
 *
 * `wanted` is what was refused: a run, one of the two pieces of upkeep that rewrite the list,
 * or (`check`) a look at the folder that changes nothing but would be misleading while the
 * list is being written.
 */
export class RunInProgressError extends Error {
  constructor(
    readonly holder: RunLockHolder | null,
    readonly wanted: RunLockPurpose | 'check' = 'run',
  ) {
    const since = holder && !Number.isNaN(Date.parse(holder.startedAt))
      ? ` (it started at ${new Date(holder.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })})`
      : '';
    super(`${busyWith(holder, wanted)}${since}. ${whatHappened(holder, wanted)}`);
    this.name = 'RunInProgressError';
  }
}

export interface RunLock {
  /** Stop refreshing the lock and remove it, if it is still this holder's. */
  release(): Promise<void>;
}

export interface RunLockOptions {
  /** What the lock is being taken for. A run's, unless said otherwise. */
  purpose?: RunLockPurpose;
  /**
   * Told, in words, when an old-looking lock is being given time to show whether its
   * holder is still working — the one case in which taking the lock waits.
   */
  onWait?: (message: string) => void;
  /** For tests: how often a holder refreshes the lock, and so how long a doubtful one is given. */
  touchEveryMs?: number;
  /**
   * Stop, pressed or typed while taking the lock waits: the wait ends at once, the earlier
   * holder's lock is left where it was, and LockWaitStoppedError is thrown.
   */
  signal?: AbortSignal;
}

/** Asked to stop while waiting to see whether an old-looking lock's holder was still working. */
export class LockWaitStoppedError extends Error {
  constructor() {
    super('Stopped while waiting to see whether an earlier run was still going. Nothing was changed.');
    this.name = 'LockWaitStoppedError';
  }
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

const PURPOSES: readonly string[] = ['run', 'repair', 'duplicates'];

async function readHolder(file: string): Promise<RunLockHolder | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<RunLockHolder>;
    if (typeof parsed.pid !== 'number' || typeof parsed.host !== 'string' || typeof parsed.startedAt !== 'string') return null;
    const purpose = typeof parsed.purpose === 'string' && PURPOSES.includes(parsed.purpose) ? parsed.purpose : undefined;
    return { pid: parsed.pid, host: parsed.host, startedAt: parsed.startedAt, ...(purpose ? { purpose } : {}) };
  } catch {
    return null;
  }
}

const sameHolder = (a: RunLockHolder | null, b: RunLockHolder | null): boolean =>
  a !== null && b !== null && a.pid === b.pid && a.host === b.host && a.startedAt === b.startedAt;

interface Sighting {
  holder: RunLockHolder | null;
  touched: number;
}

/** The lock as it is now, or null when there is none. */
async function look(file: string): Promise<Sighting | null> {
  const holder = await readHolder(file);
  const touched = await stat(file).then((s) => s.mtimeMs, () => null);
  return touched === null ? null : { holder, touched };
}

/**
 * Whether a lock someone else holds may be taken over.
 *
 * `unsure` is the one case age alone cannot settle (security review fs-6, its second half):
 * unrefreshed for longer than STALE_MS, and yet a process with its number is alive on this
 * computer. That is a holder the computer's sleep suspended mid-run, which resumes and
 * carries on the moment it wakes — at the same moment as the daily run the scheduler missed
 * while it slept — or a holder that died and whose number the system has since given to
 * some other program. Deleting the first puts two runs in the folder; honouring the second
 * would refuse every run until that other program happened to exit.
 */
function judge(seen: Sighting): 'held' | 'abandoned' | 'unsure' {
  const here = seen.holder !== null && seen.holder.host === hostname();
  if (here && !alive((seen.holder as RunLockHolder).pid)) return 'abandoned';
  // An unreadable lock is NOT abandoned while it is fresh: the file exists, empty, for the
  // instant between its owner creating it and writing to it, and reading it in that instant
  // must not be taken as licence to delete it. Only age decides for one of those.
  if (Date.now() - seen.touched <= STALE_MS) return 'held';
  // macOS takes its host name from the network it is on when none is set, so a Mac that
  // slept mid-run on one network can wake as `name.lan` holding a lock it wrote as
  // `name.localdomain`. A name that differs only after the first dot, with the pid alive
  // here, may be this computer: it is given the wait rather than taken over at once. Never
  // the other way — a dead pid under such a name is not proof of anything, because two
  // computers can share a short name ("MacBook-Pro"), so that lock is judged by age alone.
  const perhapsHere =
    !here && seen.holder !== null && shortName(seen.holder.host) === shortName(hostname()) && alive(seen.holder.pid);
  return here || perhapsHere ? 'unsure' : 'abandoned';
}

const shortName = (host: string): string => host.split('.')[0]!.toLowerCase();

/**
 * Take the folder's lock, or throw RunInProgressError.
 *
 * Throws the filesystem's own error, untranslated, when the lock cannot be created at all —
 * ENOENT when the folder does not exist yet, which the caller decides the meaning of.
 */
export async function takeRunLock(root: string, options: RunLockOptions = {}): Promise<RunLock> {
  const file = join(root, RUN_LOCK_FILENAME);
  const purpose = options.purpose ?? 'run';
  const touchEveryMs = options.touchEveryMs ?? TOUCH_EVERY_MS;
  const me: RunLockHolder = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), purpose };
  let waited = false;

  // Three tries at most: once; again after a lock whose run just finished vanished between
  // two looks at it, or after clearing an abandoned one; and a last time after both.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(me));
      await handle.close();
      return held(file, me, touchEveryMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const seen = await look(file);
    // Gone between the two calls: its holder just finished, so try again at once.
    if (!seen) continue;
    let verdict = judge(seen);
    if (verdict === 'unsure' && !waited) {
      // A holder that is alive refreshes the lock every touchEveryMs while it is awake, and
      // one the computer's sleep suspended does so within one interval of waking, so twice
      // that tells the two cases apart by what the holder does rather than by its age.
      waited = true;
      options.onWait?.('An earlier run left this folder marked as in use. Checking whether it is still going; this takes a minute.');
      await delay(2 * touchEveryMs, undefined, { signal: options.signal }).catch(() => {});
      if (options.signal?.aborted) throw new LockWaitStoppedError();
      const again = await look(file);
      if (!again) continue;
      // Refreshed in the meantime, or replaced by a new holder: either way, someone is working.
      if (again.touched !== seen.touched || !sameHolder(again.holder, seen.holder)) {
        throw new RunInProgressError(again.holder, purpose);
      }
      verdict = 'abandoned';
    }
    if (verdict !== 'abandoned') throw new RunInProgressError(seen.holder, purpose);
    await rm(file, { force: true });
  }
  throw new RunInProgressError(await readHolder(file), purpose);
}

/**
 * The refusal someone would meet now, without taking the lock: null when the folder is free.
 *
 * For a look at the folder that changes nothing — "check the archive" and "look for
 * duplicates" — which, while a run is writing the list, would describe a list that is half
 * written; and for the command line to say so before it asks a parent to confirm a change
 * that the lock would then refuse. It never waits: only a lock that is plainly in use
 * counts, and one that may be abandoned is left for takeRunLock to settle, so a lock left by
 * a run that died cannot stop a parent from looking.
 */
export async function runLockRefusal(root: string, wanted: RunLockPurpose | 'check'): Promise<RunInProgressError | null> {
  const seen = await look(join(root, RUN_LOCK_FILENAME));
  return seen && judge(seen) === 'held' ? new RunInProgressError(seen.holder, wanted) : null;
}

function held(file: string, me: RunLockHolder, touchEveryMs: number): RunLock {
  const timer = setInterval(() => {
    // Only our own. A lock taken over from this holder — by another computer that found it
    // unrefreshed while this one slept — belongs to the holder that took it.
    void readHolder(file)
      .then((holder) => {
        if (!sameHolder(holder, me)) return;
        const now = new Date();
        return utimes(file, now, now);
      })
      .catch(() => {});
  }, touchEveryMs);
  // The work holding the lock keeps the process alive, not the refresh of it: a timer left
  // behind by a holder that forgot to release must not stop the process from exiting.
  timer.unref();
  return {
    async release() {
      clearInterval(timer);
      // Only our own, for the same reason: removing a lock another holder took over would let
      // a third in beside it.
      if (sameHolder(await readHolder(file), me)) await rm(file, { force: true });
    },
  };
}
