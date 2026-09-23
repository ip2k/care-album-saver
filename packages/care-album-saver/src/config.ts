import { Secret } from './secrets.js';
import { inspectCookiePaste } from './paste.js';
import { acceptableUserAgent } from './api/identity.js';

/** RFC 6265 cookie-octet: what a cookie value may contain, and all a saved one may hold. */
const COOKIE_OCTETS = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;
import { configPath, defaultArchiveDir, readJsonFile, sessionPath, writeSecureFile } from './paths.js';

export interface Config {
  /** Where the photos are saved. */
  archiveDir: string;
  /** Folder layout. */
  organiseBy: 'week' | 'week-per-child' | 'child-then-week';
  /** Write the child's name into the file's metadata so photo apps can group by person. */
  tagChildName: boolean;
  /** Write the teacher's note into the file's description field. */
  tagNote: boolean;
  /** Remove GPS coordinates if Brightwheel ever includes them. */
  stripLocation: boolean;
  /** Also write a .xmp sidecar next to each photo, for Lightroom and darktable. */
  writeSidecar: boolean;
  /** Milliseconds between API requests. */
  delayMs: number;
  /** Only fetch posts newer than the newest one already saved. */
  incremental: boolean;
  /** Children to include, by Brightwheel id. Empty means all of them. */
  includeStudents: string[];
  /**
   * The daily run, as this tool last set it up. `null` means there is none.
   *
   * The operating system's own scheduler is the authority on whether the job exists —
   * `schedule.status()` asks it — but the answer to "what did we ask for, and where did we
   * write it" has to be kept here. Without it the setup page could show that something is
   * scheduled and not what time it runs, which is the one thing a parent wants to know.
   */
  schedule: ScheduleRecord | null;
  /**
   * Also add each run's new photos to the Photos app. macOS only, and OFF unless the parent
   * turns it on — because a Photos library with iCloud Photos switched on uploads whatever
   * is added to it, and "nothing leaves this computer" is otherwise this tool's promise.
   * See src/photos.ts and docs/PHOTOS.md.
   */
  addToPhotos: boolean;
  /**
   * Only files saved at or after this moment are added to Photos; `null` means every file
   * in the archive. Set to the moment the option is turned on, so that turning it on does
   * not pour years of photos into a library unasked. Going back further is a separate,
   * explicit choice ("add the earlier ones too"). Written by the server only, never taken
   * from a settings patch.
   */
  addToPhotosFrom: string | null;
}

/** Which of the operating system's schedulers is holding the daily run. */
export type ScheduleMechanism = 'launchd' | 'systemd' | 'cron' | 'schtasks';

export interface ScheduleRecord {
  /** Time of day on this computer's own clock, 24-hour, as `HH:MM`. */
  time: string;
  mechanism: ScheduleMechanism;
  /**
   * The file or scheduler entry that holds it, spelled out so that a parent can find it —
   * and delete it — years from now without this tool being installed.
   */
  location: string;
  installedAt: string;
  /**
   * The absolute path in this job that will not survive an upgrade — a Node under a
   * version manager, or an entry point in an npx cache — or null when both look durable.
   * Recorded at install so that "set up, never ran" can say which of its two causes it is.
   */
  fragilePath?: string | null;
}

export const DEFAULT_CONFIG: Config = {
  archiveDir: defaultArchiveDir(),
  organiseBy: 'child-then-week',
  tagChildName: true,
  tagNote: true,
  stripLocation: true,
  writeSidecar: false,
  delayMs: 400,
  incremental: true,
  includeStudents: [],
  schedule: null,
  addToPhotos: false,
  addToPhotosFrom: null,
};

export async function loadConfig(): Promise<Config> {
  const stored = await readJsonFile<Partial<Config>>(configPath());
  return { ...DEFAULT_CONFIG, ...(stored ?? {}) };
}

export async function saveConfig(config: Config): Promise<void> {
  await writeSecureFile(configPath(), JSON.stringify(config, null, 2));
}

interface StoredSession {
  cookie: string;
  savedAt: string;
  email?: string | null;
  /**
   * The User-Agent of the browser the session was pasted from, sent with every request so
   * that the session and the identity carrying it agree. Null when no browser was involved.
   */
  userAgent?: string | null;
}

/**
 * Load the saved session.
 *
 * Returned as a `Secret`, never a bare string, so that it cannot reach a log by accident
 * anywhere downstream.
 */
export async function loadSession(): Promise<{
  session: Secret;
  savedAt: Date;
  email: string | null;
  userAgent: string | null;
} | null> {
  if (process.env.CARE_ALBUM_SESSION || process.env.BRIGHTWHEEL_SESSION) {
    // Supported for Docker and CI, but the README explains why a mounted file is better:
    // environment variables leak into process listings, shell history and crash dumps.
    // BRIGHTWHEEL_SESSION is the pre-rename spelling, still read so that an existing
    // container or CI job does not stop working on an upgrade.
    const value = process.env.CARE_ALBUM_SESSION || process.env.BRIGHTWHEEL_SESSION || '';
    if (!COOKIE_OCTETS.test(value)) return null;
    return { session: new Secret(value), savedAt: new Date(), email: null, userAgent: null };
  }
  const stored = await readJsonFile<StoredSession>(sessionPath());
  if (!stored?.cookie) return null;
  // A saved value that could not be sent as a cookie header is treated as no session at
  // all: an HTTP client asked to send it would refuse, quoting it back in its complaint.
  if (typeof stored.cookie !== 'string' || !COOKIE_OCTETS.test(stored.cookie)) return null;
  return {
    session: new Secret(stored.cookie),
    savedAt: new Date(stored.savedAt),
    email: stored.email ?? null,
    // Re-checked on the way in: this file can be edited by hand, and the value goes out as
    // a header on every request.
    userAgent: acceptableUserAgent(stored.userAgent),
  };
}

export async function saveSession(cookie: Secret, email: string | null, userAgent: string | null = null): Promise<void> {
  const payload: StoredSession = {
    cookie: cookie.expose(),
    savedAt: new Date().toISOString(),
    email,
    userAgent: acceptableUserAgent(userAgent),
  };
  await writeSecureFile(sessionPath(), JSON.stringify(payload, null, 2));
}

/**
 * Accept a session cookie in any of the forms a parent might realistically paste:
 * the bare value, `name=value`, or a whole Cookie header with several pairs.
 * Being forgiving here removes the most common support question.
 */
export function normaliseCookieInput(input: string): Secret | null {
  const verdict = inspectCookiePaste(input);
  return verdict.ok ? new Secret(verdict.value) : null;
}

