import { randomBytes } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { link, lstat, open, rename, rm, utimes, type FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
 * when it has not been refreshed for STALE_MS, or was taken more than FOREIGN_MAX_MS ago.
 * Taking one over moves it aside first and removes it only if it is still the lock that was
 * judged abandoned (see setAsideIfUnchanged), so two runs that judge the same lock at once
 * cannot both end up holding the folder.
 */

export const RUN_LOCK_FILENAME = '.care-album-saver.lock';

/** How long a lock may go unrefreshed before it is presumed abandoned. */
const STALE_MS = 30 * 60 * 1000;

/**
 * How long a lock written on another computer is honoured, however recently it was refreshed
 * (security review processes-10).
 *
 * Its process cannot be asked about from here, so only its refreshes speak for it, and those
 * are easy to keep coming: a run hung on something that never answers still refreshes on its
 * timer, and anything else that can write the folder can refresh a lock it planted. Either
 * would stop every run here for as long as it went on. No run takes a day — a first run of a
 * large archive takes hours — so a day after it was taken, a lock from elsewhere is set aside.
 */
const FOREIGN_MAX_MS = 24 * 60 * 60 * 1000;

/** A lock file is a line of JSON; anything larger at its name is not one this tool wrote. */
const LOCK_MAX_BYTES = 64 * 1024;

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
  /**
   * Random, per taking: two holders in one process, started in the same millisecond, are
   * still told apart. Absent in a lock written before 2026-09-24.
   */
  token?: string;
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

/**
 * Something is at the lock's name that this tool never makes there: a symbolic link (dangling
 * or not), a folder, a device. Security review, the filesystem verifier's "lock not a file".
 *
 * Deliberately NOT a RunInProgressError. That one is "someone else is busy, nothing to worry
 * about", which the daily run records as a skip; a dangling link read that way stopped every
 * run for ever while saying all was well, and a folder there threw a raw EISDIR. This is a
 * failure, recorded and notified as one, and it says what to do: nothing but a person can
 * decide what that thing is, so this tool neither follows it nor removes it.
 */
export class RunLockUnusableError extends Error {
  constructor(readonly path: string, what: string) {
    super(
      `Something called ${basename(path)} is in ${dirname(path)}, and it is not the lock file this tool makes ` +
        `there: it is ${what}. Nothing was changed. Move it out of that folder, then try again.`,
    );
    this.name = 'RunLockUnusableError';
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

/**
 * How a lock file is opened for reading: never through a symbolic link, and never waiting on
 * a FIFO planted at its name. O_NOFOLLOW and O_NONBLOCK where the platform has them; Windows
 * has neither, and there the lstat in readLockText is the check.
 */
const READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/**
 * A lock file's text: null when there is nothing at the name, when what is there is not an
 * ordinary file, or when it is far too large to be a lock. Every read of a lock goes through
 * this, the holder's own refresh and release included, so a link or a device put at the name
 * is never read through.
 */
async function readLockText(file: string): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    if (!(await lstat(file)).isFile()) return null;
    handle = await open(file, READ_FLAGS);
    const info = await handle.stat();
    if (!info.isFile() || info.size > LOCK_MAX_BYTES) return null;
    return await handle.readFile('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseHolder(text: string | null): RunLockHolder | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as Partial<RunLockHolder> | null;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.pid !== 'number' || typeof parsed.host !== 'string' || typeof parsed.startedAt !== 'string') return null;
    const purpose = typeof parsed.purpose === 'string' && PURPOSES.includes(parsed.purpose) ? parsed.purpose : undefined;
    const token = typeof parsed.token === 'string' ? parsed.token : undefined;
    return {
      pid: parsed.pid,
      host: parsed.host,
      startedAt: parsed.startedAt,
      ...(purpose ? { purpose } : {}),
      ...(token ? { token } : {}),
    };
  } catch {
    return null;
  }
}

async function readHolder(file: string): Promise<RunLockHolder | null> {
  return parseHolder(await readLockText(file));
}

const sameHolder = (a: RunLockHolder | null, b: RunLockHolder | null): boolean =>
  a !== null && b !== null && a.pid === b.pid && a.host === b.host && a.startedAt === b.startedAt && a.token === b.token;

/**
 * A lock file as found, so that what is done about it can be done only if it is unchanged
 * (see setAsideIfUnchanged). Shared with the Photos step's own lock, in photos.ts.
 */
export interface LockSighting {
  /** When it was last refreshed: its modification time, as lstat reads it. */
  touched: number;
  /** Its text, or null when it cannot be read (or is not an ordinary file). */
  text: string | null;
  /** Set when what is at the name is not an ordinary file: what it is, in words. */
  notAFile?: string;
}

/** The lock at `file` as it is now, or null when there is nothing at that name. */
export async function sightLock(file: string): Promise<LockSighting | null> {
  const seen = async (): Promise<Stats | null> => {
    try {
      return await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const info = await seen();
  if (!info) return null;
  if (!info.isFile()) {
    const what = info.isSymbolicLink() ? 'a link to somewhere else' : info.isDirectory() ? 'a folder' : 'not an ordinary file';
    return { touched: info.mtimeMs, text: null, notAFile: what };
  }
  const text = await readLockText(file);
  // Unreadable because it has gone since: its holder just finished.
  if (text === null && !(await seen())) return null;
  return { touched: info.mtimeMs, text };
}

/**
 * Remove a lock judged abandoned, only if it is still the lock that was judged, and only one
 * taker at a time (security review fs-7). Returns when the lock may be tried for again.
 *
 * Two runs — or three: the daily run, a press of "Save new photos", a repair from the command
 * line — can judge one lock abandoned at the same moment, straight after the computer wakes.
 * This used to remove the lock by name, and the second to do so could remove the lock the
 * first had just made in its place; both then saved into the folder. Moving the lock aside
 * with a rename and comparing what was moved is not enough on its own: a rename that moves a
 * fresh lock by mistake leaves its name free until the lock is put back, and a third run
 * takes the name in that moment (a test with three found it). So a taker first makes a small
 * guard file beside the lock, with 'wx', which only one can hold; holding it, it looks again,
 * and removes the lock only if it is still the one judged, by its text and its last refresh.
 * A taker that finds the guard held gives the one holding it a moment, then tries the lock
 * again — and finds it free, or finds the new holder's lock and is refused.
 *
 * Not by inode: on an exFAT or FAT drive, where a parent may well keep an archive shared
 * between a Mac and a PC, a file's number changes when it is renamed.
 */
export async function setAsideIfUnchanged(file: string, judged: LockSighting): Promise<void> {
  const release = await takeGuard(`${file}.takeover`);
  if (!release) {
    await delay(GUARD_BACKOFF_MS);
    return;
  }
  try {
    await removeIfStill(file, judged);
  } finally {
    await release();
  }
}

/** How long the guard is held: a look, a rename, a look and a removal. */
const GUARD_STALE_MS = 60 * 1000;
/** How long a taker that finds the guard held gives its holder. */
const GUARD_BACKOFF_MS = 100;

/**
 * Take the takeover guard, or null when another taker holds it. A guard older than
 * GUARD_STALE_MS was left by a process that died holding it, and is removed as a lock is.
 */
async function takeGuard(guard: string): Promise<(() => Promise<void>) | null> {
  const mine = `${process.pid} ${randomBytes(8).toString('hex')}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(guard, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (handle) {
      await writeLockOrRemove(handle, guard, mine);
      return async () => {
        const now = await sightLock(guard).catch(() => null);
        if (now?.text === mine) await rm(guard, { force: true });
      };
    }
    const seen = await sightLock(guard);
    if (!seen) continue;
    if (seen.notAFile !== undefined) throw new RunLockUnusableError(guard, seen.notAFile);
    if (Date.now() - seen.touched < GUARD_STALE_MS) return null;
    await removeIfStill(guard, seen);
  }
  return null;
}

const unchanged = (now: LockSighting | null, judged: LockSighting): boolean =>
  now !== null && now.notAFile === undefined && now.text === judged.text && now.touched === judged.touched;

/**
 * Remove `file` if it is still what was judged. Looked at first, and moved aside before it is
 * removed, so that a lock whose holder released it an instant ago and which a new holder has
 * already made again is put back rather than removed.
 */
async function removeIfStill(file: string, judged: LockSighting): Promise<void> {
  if (!unchanged(await sightLock(file), judged)) return;
  const aside = `${file}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await rename(file, aside);
  } catch (error) {
    // Gone already: its holder finished.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (unchanged(await sightLock(aside).catch(() => null), judged)) {
    await rm(aside, { force: true });
    return;
  }
  await putBack(aside, file);
}

/**
 * Return a lock moved aside by mistake to its name, without overwriting a lock made there in
 * the meantime: a hard link replaces nothing, and where the disk has none (FAT, exFAT) a
 * rename is used only while the name is free. When another lock is already there, the moved
 * one is removed rather than left lying about.
 */
async function putBack(aside: string, file: string): Promise<void> {
  try {
    await link(aside, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      const free = await lstat(file).then(
        () => false,
        (e: NodeJS.ErrnoException) => e.code === 'ENOENT',
      );
      if (free && (await rename(aside, file).then(() => true, () => false))) return;
    }
  }
  await rm(aside, { force: true });
}

/**
 * Write a lock file just made with 'wx' in full, or take it away again. A lock left empty by
 * a write that failed — a full disk — reads as someone else's until it is old enough to be
 * judged abandoned, and meanwhile refuses every run (security review processes-6, which found
 * it in the Photos step's lock; this one had it too).
 */
export async function writeLockOrRemove(handle: FileHandle, file: string, text: string): Promise<void> {
  try {
    await handle.writeFile(text);
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(file, { force: true }).catch(() => {});
    throw error;
  }
}

interface Sighting {
  holder: RunLockHolder | null;
  touched: number;
  found: LockSighting;
}

/**
 * The lock as it is now, or null when there is none. Throws RunLockUnusableError when what is
 * at its name is not an ordinary file.
 */
async function look(file: string): Promise<Sighting | null> {
  const found = await sightLock(file);
  if (!found) return null;
  if (found.notAFile !== undefined) throw new RunLockUnusableError(file, found.notAFile);
  return { holder: parseHolder(found.text), touched: found.touched, found };
}

/** Whether a lock taken at `startedAt` on another computer is still within FOREIGN_MAX_MS. */
function recentEnough(startedAt: string): boolean {
  const at = Date.parse(startedAt);
  // Either way: a lock claiming to have been taken next week is honoured no longer than one
  // taken last week. A time no clock can read is not one this tool wrote.
  return Number.isFinite(at) && Math.abs(Date.now() - at) <= FOREIGN_MAX_MS;
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
  // From another computer — or one that says so — and taken more than a day ago, however
  // recently it was refreshed: see FOREIGN_MAX_MS (security review processes-10).
  if (seen.holder !== null && !here && !recentEnough(seen.holder.startedAt)) return 'abandoned';
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
 * Throws RunLockUnusableError when something that is not an ordinary file is at the lock's
 * name, and the filesystem's own error, untranslated, when the lock cannot be created at all —
 * ENOENT when the folder does not exist yet, which the caller decides the meaning of.
 */
export async function takeRunLock(root: string, options: RunLockOptions = {}): Promise<RunLock> {
  const file = join(root, RUN_LOCK_FILENAME);
  const purpose = options.purpose ?? 'run';
  const touchEveryMs = options.touchEveryMs ?? TOUCH_EVERY_MS;
  const me: RunLockHolder = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    purpose,
    token: randomBytes(8).toString('hex'),
  };
  let waited = false;

  // Three tries at most: once; again after a lock whose run just finished vanished between
  // two looks at it, or after clearing an abandoned one; and a last time after both.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(file, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        // A folder at the name is EEXIST here, but may be EISDIR or EPERM elsewhere (Windows).
        const found = await sightLock(file).catch(() => null);
        if (found?.notAFile !== undefined) throw new RunLockUnusableError(file, found.notAFile);
        throw error;
      }
    }
    if (handle) {
      await writeLockOrRemove(handle, file, JSON.stringify(me));
      return held(file, me, touchEveryMs);
    }
    const seen = await look(file);
    // Gone between the two calls: its holder just finished, so try again at once.
    if (!seen) continue;
    let judged = seen;
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
      judged = again;
      verdict = 'abandoned';
    }
    if (verdict !== 'abandoned') throw new RunInProgressError(seen.holder, purpose);
    await setAsideIfUnchanged(file, judged.found);
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
 * a run that died cannot stop a parent from looking. Nor can something at the lock's name
 * that is not a lock: takeRunLock says what that is, when there is something to take.
 */
export async function runLockRefusal(root: string, wanted: RunLockPurpose | 'check'): Promise<RunInProgressError | null> {
  const seen = await look(join(root, RUN_LOCK_FILENAME)).catch(() => null);
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
