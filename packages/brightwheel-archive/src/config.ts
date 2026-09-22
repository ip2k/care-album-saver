import { Secret } from './secrets.js';
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
}

/**
 * Load the saved session.
 *
 * Returned as a `Secret`, never a bare string, so that it cannot reach a log by accident
 * anywhere downstream.
 */
export async function loadSession(): Promise<{ session: Secret; savedAt: Date; email: string | null } | null> {
  if (process.env.BRIGHTWHEEL_SESSION) {
    // Supported for Docker and CI, but the README explains why a mounted file is better:
    // environment variables leak into process listings, shell history and crash dumps.
    return { session: new Secret(process.env.BRIGHTWHEEL_SESSION), savedAt: new Date(), email: null };
  }
  const stored = await readJsonFile<StoredSession>(sessionPath());
  if (!stored?.cookie) return null;
  return {
    session: new Secret(stored.cookie),
    savedAt: new Date(stored.savedAt),
    email: stored.email ?? null,
  };
}

export async function saveSession(cookie: Secret, email: string | null): Promise<void> {
  const payload: StoredSession = {
    cookie: cookie.expose(),
    savedAt: new Date().toISOString(),
    email,
  };
  await writeSecureFile(sessionPath(), JSON.stringify(payload, null, 2));
}

/**
 * Accept a session cookie in any of the forms a parent might realistically paste:
 * the bare value, `name=value`, or a whole Cookie header with several pairs.
 * Being forgiving here removes the most common support question.
 */
export function normaliseCookieInput(input: string): Secret | null {
  const text = input.trim().replace(/^Cookie:\s*/i, '');
  if (!text) return null;
  const match = text.match(/_brightwheel_v2=([^;\s]+)/);
  if (match?.[1]) return new Secret(decodeURIComponent(match[1]));
  if (!text.includes('=') && !text.includes(';')) return new Secret(text);
  return null;
}
