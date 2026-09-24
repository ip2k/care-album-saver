import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, platform as osPlatform, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, readJsonFile, UnreadableFileError, writeSecureFile } from './paths.js';
import { scrub } from './secrets.js';
import { logTimestamp } from './log-lines.js';
import { ConfigUnusableError, loadConfig, saveConfig, type Config, type ScheduleMechanism, type ScheduleRecord } from './config.js';
import { isProductionRoot } from './environment.js';

/**
 * The daily run: installing it, asking after it, and taking it away again.
 *
 * Archiving a child's photos is not a thing anyone remembers to do. The one-off run is the
 * setup; the point is the run that happens every evening afterwards without being asked.
 * So this hands the job to whichever scheduler the operating system already has, rather
 * than leaving a daemon of ours running — a background process of our own would have to be
 * kept alive, restarted at login and explained, and all three are solved problems that the
 * platform solves better:
 *
 *  - macOS: a launchd LaunchAgent. cron still runs on a Mac but Apple has deprecated it,
 *    and it has no answer for a laptop that was asleep at the appointed minute; launchd
 *    runs a missed StartCalendarInterval job when the machine wakes.
 *  - Linux: a systemd --user timer where systemd is present (`Persistent=true` gives the
 *    same catch-up behaviour), and a crontab line where it is not.
 *  - Windows: schtasks.exe, the built-in Task Scheduler.
 *
 * Three rules hold everywhere in this file.
 *
 * Every command this tool runs itself is run with `execFile` and an argument array — never a
 * shell string, and never `exec` — so a path handed to launchctl, systemctl, crontab or
 * schtasks arrives as one argument, whatever the folder is called.
 *
 * The job the scheduler runs later is another matter, and an earlier version of this comment
 * was wrong to say the argument array covered it. Three of the four schedulers take the job
 * as text and read that text their own way: cron hands its line to /bin/sh, systemd applies
 * its own quoting, `%` specifiers and `$` variables to ExecStart=, and Task Scheduler expands
 * `%NAME%` in a task's command and arguments before the C runtime splits them. The paths in
 * the job come from the machine (`execPath`, the home directory) rather than from anything a
 * parent types, but a folder called `$(…)` did run as a command from the crontab (security
 * review processes-1). So each path is spelled for the reader it is going to — cronWord,
 * systemdWord and windowsArg below — and a path that none of them can carry, one with a line
 * break or another control character in its name, is refused before anything is written.
 * launchd is the one that needs nothing: its ProgramArguments is an array, and the only
 * spelling in the plist is XML's.
 *
 * And nothing here goes near `npx`. A scheduled job cannot find a bare `npx` (its PATH is
 * almost empty), and on Windows it would need `npx.cmd`. Writing the entry itself, the tool
 * can do better than any advice about that: it records the absolute path of the Node binary
 * running right now and the absolute path of this tool's own command-line entry point, so
 * there is no PATH lookup, no shim, and nothing to get wrong.
 */

/** The label, unit and task name. One job, one name, on every platform. */
const LAUNCHD_LABEL = 'com.care-album-saver.daily';
const SYSTEMD_UNIT = 'care-album-saver';
const SCHTASKS_NAME = 'Care Album Saver daily';

/**
 * The first line of the crontab block this tool owns.
 *
 * A crontab belongs to the person, not to us: it may well hold lines they wrote themselves.
 * So installing rewrites only the lines from this marker to CRON_END, and removing takes
 * only those away. Anything unmarked is copied through untouched.
 */
const CRON_MARKER = '# care-album-saver: the daily run. Delete this block to stop it.';
/** Closes the block. */
const CRON_END = '# care-album-saver: end of the daily run.';

export interface CommandResult {
  /** Exit status. 127 stands in for "the program is not installed". */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * How this module reaches the operating system.
 *
 * Injected rather than imported so the tests can assert exactly what would be run, on a
 * machine that is not the one being tested for — the Windows and Linux branches below were
 * written on a Mac, and a scheduler is not something a test may install for real.
 */
export type CommandRunner = (file: string, args: string[], input?: string) => Promise<CommandResult>;

const defaultRunner: CommandRunner = (file, args, input) =>
  new Promise((resolve) => {
    const child = execFile(file, args, { windowsHide: true, timeout: 30_000 }, (error, stdout, stderr) => {
      // `error.code` is the exit status for a program that ran and failed, and a string
      // like 'ENOENT' for one that never started. Both are failures here; only the first
      // has a number worth reporting.
      const status = error ? (typeof error.code === 'number' ? error.code : 127) : 0;
      resolve({ code: status, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
    if (input !== undefined) child.stdin?.end(input);
  });

export interface ScheduleEnvironment {
  platform?: NodeJS.Platform;
  home?: string;
  run?: CommandRunner;
  /**
   * The Node binary the scheduled run should use. Defaults to the one running now; either
   * way a Homebrew keg path is rewritten by durableNodePath.
   */
  nodePath?: string;
  /** This tool's command-line entry point. Defaults to `cli.js` beside this file. */
  cliPath?: string;
  /** POSIX user id, for launchctl's `gui/<uid>` domain. */
  uid?: number;
}

interface Resolved {
  platform: NodeJS.Platform;
  home: string;
  run: CommandRunner;
  nodePath: string;
  cliPath: string;
  uid: number;
}

function resolveEnv(env: ScheduleEnvironment = {}): Resolved {
  return {
    platform: env.platform ?? osPlatform(),
    home: env.home ?? homedir(),
    run: env.run ?? defaultRunner,
    nodePath: durableNodePath(env.nodePath ?? process.execPath),
    // `cli.js` is this file's neighbour in `dist`, which is the one place it is certain to
    // be: resolving it through the package name would depend on how the tool was installed.
    cliPath: env.cliPath ?? fileURLToPath(new URL('./cli.js', import.meta.url)),
    uid: env.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0),
  };
}

/** The arguments the scheduled job runs. `--scheduled` is what writes the last-run record. */
const RUN_ARGS = ['run', '--scheduled'];

/**
 * Paths that will not survive the next upgrade of the thing that owns them.
 *
 * A scheduled job records the absolute path of the Node binary and of this tool's entry
 * point, which is what lets it avoid every `npx` problem. The cost is that both paths have
 * to keep existing. A Node installed by a version manager lives under a version number
 * that a later `nvm install` leaves behind, and a tool run through `npx` or `dlx` lives in
 * a cache that is cleaned. Either way the job stays registered and silently does nothing —
 * the exact failure `status` cannot otherwise tell from "nothing new to save".
 */
const EPHEMERAL = new RegExp(
  [
    String.raw`[\/\\](?:\.nvm|\.volta|\.fnm|_npx|\.pnpm-store)[\/\\]`,
    String.raw`[\/\\]dlx-`,
    // asdf and mise keep one folder per version; so do nodenv, fnm's current default
    // (…/fnm/node-versions/v22…/installation) and nvm under XDG (~/.config/nvm/versions).
    String.raw`[\/\\](?:\.asdf|mise)[\/\\]installs[\/\\]`,
    String.raw`[\/\\]\.nodenv[\/\\]versions[\/\\]`,
    String.raw`[\/\\]fnm[\/\\]node-versions[\/\\]`,
    String.raw`[\/\\]\.?nvm[\/\\]versions[\/\\]`,
  ].join('|'),
  'i',
);

/**
 * A Homebrew keg: <prefix>/Cellar/<formula>/<version>/…, the shape durableNodePath parses.
 * Case-sensitive and tested against the Node path only, so that a project in a folder that
 * merely happens to be called "cellar" is not reported as fragile.
 */
const KEG = /[\/\\]Cellar[\/\\][^\/\\]+[\/\\][^\/\\]+[\/\\]/;

/**
 * The Node binary to write into the job, spelled so that it survives an upgrade.
 *
 * `process.execPath` is the binary after every symlink has been followed. Under Homebrew
 * that is the versioned keg — /opt/homebrew/Cellar/node/26.9.0/bin/node — even though the
 * shell found `node` at /opt/homebrew/bin/node. `brew upgrade` installs the next version
 * beside it and its cleanup deletes the old one, after which a job pointing into it stays
 * registered and never runs again, with nothing to say so. That was every Homebrew Node,
 * which is how most Macs have Node at all.
 *
 * Homebrew keeps a link that follows upgrades: <prefix>/opt/<formula>, repointed at the
 * current keg each time, and present even for a keg-only formula such as node@22 that is
 * never linked into <prefix>/bin. So a keg path becomes the same file under opt/ — but only
 * when that link exists and leads back into the same formula's own kegs, so a link that
 * points somewhere unexpected is never trusted. Anything else is returned as it was, and
 * KEG is then what reports it as fragile.
 */
export function durableNodePath(execPath: string): string {
  const keg = /^(.*)[\/\\]Cellar[\/\\]([^\/\\]+)[\/\\][^\/\\]+[\/\\](.+)$/.exec(execPath);
  if (!keg) return execPath;
  const [, prefix, formula, inside] = keg as unknown as [string, string, string, string];
  let kegs: string;
  try {
    kegs = realpathSync(join(prefix, 'Cellar', formula)) + sep;
  } catch {
    return execPath;
  }
  // Where opt/ can be, in the order Homebrew's own layouts make likely: beside the Cellar
  // (every standard install); one level up, for the older Intel layout that keeps the
  // Cellar inside the repository (/usr/local/Homebrew/Cellar, opt at /usr/local/opt); and
  // HOMEBREW_PREFIX, which `brew shellenv` exports, for a Cellar symlinked onto another
  // volume — execPath is the resolved path, so it names that volume, not the prefix.
  const candidates = [join(prefix, 'opt', formula, inside), join(prefix, '..', 'opt', formula, inside)];
  if (process.env.HOMEBREW_PREFIX) candidates.push(join(process.env.HOMEBREW_PREFIX, 'opt', formula, inside));
  for (const stable of candidates) {
    try {
      const target = realpathSync(stable);
      if (target.startsWith(kegs) && statSync(target).isFile()) return stable;
    } catch {
      // Not here: try the next place, and in the end keep the keg path, which works today.
    }
  }
  return execPath;
}

/**
 * Tell the person something happened, using whatever the desktop already has.
 *
 * A scheduled run fails while nobody is watching, and `last-run.json` only answers the
 * question once somebody thinks to ask it. This is the nudge that makes them ask.
 *
 * The text is fixed and names nobody: a notification is drawn by the operating system,
 * may sit in a notification centre for days, and on a shared screen is read by whoever
 * walks past. It never carries the error, a child's name or a path. Launched with an
 * argument array like everything else here, and a failure to notify is never a failure of
 * the run — if the desktop has no notifier, the run's own record is still written.
 */
export async function notify(message: string, env: ScheduleEnvironment = {}): Promise<boolean> {
  // Under test, never the real notifier: see scripts/test-env.js.
  if (!env.run && process.env.CARE_ALBUM_NO_NOTIFY) return false;
  const e = resolveEnv(env);
  const title = 'Care Album Saver';
  try {
    if (e.platform === 'darwin') {
      // Each message is a literal here, never interpolated from an error: this is
      // AppleScript source, and the argument array does not protect its contents. A message
      // this function does not know is not shown at all.
      const script = message === FAILED_NOTICE
        ? `display notification "The daily photo run did not work. Open the setup assistant to see why." with title "${title}"`
        : message === PHOTOS_NOTICE
          ? `display notification "Your new photos were saved, but could not be added to Photos. Open the setup assistant to see why." with title "${title}"`
          : null;
      if (!script) return false;
      return (await e.run('osascript', ['-e', script])).code === 0;
    }
    if (e.platform === 'win32') return false;
    return (await e.run('notify-send', [title, message])).code === 0;
  } catch {
    return false;
  }
}

/** One of the two notices this tool sends. Fixed text, so nothing about a family can reach it. */
export const FAILED_NOTICE = 'The daily photo run did not work. Open the setup assistant to see why.';

/**
 * The photos were saved but Photos would not take them — nearly always a permission macOS
 * has not granted to the daily run. Shown once, when it starts failing, not every evening.
 */
export const PHOTOS_NOTICE = 'Your new photos were saved, but could not be added to Photos. Open the setup assistant to see why.';

export interface TimeOfDay {
  hour: number;
  minute: number;
}

/**
 * Read a time a person chose, refusing anything that is not one.
 *
 * The setup page sends `<input type="time">`, which is always `HH:MM` — but the CLI takes
 * `--at` from a terminal, and this value ends up inside a plist, a systemd unit and a
 * crontab line. Validating it here is what keeps those three from ever being handed
 * something they would misread.
 */
export function parseTimeOfDay(input: string): TimeOfDay | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(input ?? '').trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

const pad = (n: number): string => String(n).padStart(2, '0');
const formatTimeOfDay = (t: TimeOfDay): string => `${pad(t.hour)}:${pad(t.minute)}`;

/**
 * The next time of day on this computer's clock, as an instant.
 *
 * Today's if it is still to come, tomorrow's otherwise. Built by stepping a local `Date`
 * rather than by adding 24 hours, so that the day a clock goes forward or back still lands
 * on the hour the parent chose rather than an hour either side of it.
 */
export function nextOccurrence(time: TimeOfDay, from: Date = new Date()): Date {
  const next = new Date(from);
  next.setHours(time.hour, time.minute, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

// ------------------------------------------------------------------ the last run

/**
 * How the last run ended, kept beside the configuration.
 *
 * A scheduled run happens when nobody is watching, so its outcome has to survive somewhere
 * a later session can read it — otherwise "is this thing working?" has no answer, and a
 * session that expired three weeks ago looks exactly like one that is fine. It lives at
 * `<config dir>/last-run.json`, next to `config.json` and `session.json`, because that
 * directory is already outside the project tree, already owner-only, and already the place
 * `care-album-saver where` points at.
 *
 * Written with the same owner-only helper as the session, even though this file holds no
 * secret: it names children.
 */
export interface LastRun {
  at: string;
  ok: boolean;
  saved: number;
  failed: number;
  /** One sentence, already scrubbed of anything secret by the caller. */
  message: string;
  /** Whether the schedule started it or a person did. */
  trigger: 'schedule' | 'manual';
  /**
   * When the scheduler itself last started a run, carried across the runs a person starts.
   * Manual runs are recorded too — so that a run the parent just made counts as today's and
   * the missed-run catch-up does not repeat it — but "the daily run has not saved anything
   * since it was set up" is a question about the scheduler alone, and a button pressed on
   * the page must not answer it.
   */
  scheduledAt?: string | null;
}

export const lastRunPath = (): string => join(configDir(), 'last-run.json');

export async function recordRun(run: LastRun): Promise<void> {
  const previous = await loadLastRun();
  const scheduledAt =
    run.trigger === 'schedule' ? run.at : previous?.scheduledAt ?? (previous?.trigger === 'schedule' ? previous.at : null);
  await writeSecureFile(lastRunPath(), JSON.stringify({ ...run, scheduledAt }, null, 2));
}

/** The record of a run that finished, stopped or not, in the words the page and the log use. */
export function finishedRun(
  result: { saved: number; failed: number; stopped: boolean },
  trigger: LastRun['trigger'],
): LastRun {
  return {
    at: new Date().toISOString(),
    // A run cut short has not brought the archive up to date, whatever it managed before it
    // stopped, so it is not recorded as a clean one.
    ok: result.failed === 0 && !result.stopped,
    saved: result.saved,
    failed: result.failed,
    message: result.stopped
      ? `Stopped part-way; ${result.saved} item${result.saved === 1 ? '' : 's'} saved before that are kept.`
      : result.saved === 0 && result.failed === 0
        ? 'There were no new photos to save.'
        : `${result.saved} new item${result.saved === 1 ? '' : 's'} saved` +
          (result.failed > 0 ? `, ${result.failed} could not be fetched.` : '.'),
    trigger,
  };
}

/**
 * Whether a scheduled run has work to do, or whether this is a catch-up for one that
 * already happened.
 *
 * Every platform's catch-up fires more often than the schedule does — launchd at each
 * login, cron at each boot, Task Scheduler when it notices a missed start, systemd when
 * a timer it persisted comes due. Without this guard, "make missed runs happen" would
 * read to a parent as "runs every time I turn the computer on", and would put a listing
 * request per child on Brightwheel for nothing.
 *
 * The rule is the simplest one that is right: find the most recent time the schedule
 * should have fired at or before now, and ask whether a run has succeeded since. If one
 * has, this invocation is a catch-up for an occurrence already covered, and there is
 * nothing to do. If none has — the machine was off at seven, or the run failed — it is
 * due, which is exactly the case all of this exists for.
 *
 * A failed run does not count as covering the occurrence, so the next login or boot
 * retries it. That is deliberate: the common cause of failure is an expired session, and
 * the next attempt is how a parent who has since reconnected gets their evening back.
 */
export function isDue(
  record: { time: string } | null | undefined,
  lastRun: LastRun | null,
  now = new Date(),
): boolean {
  // No schedule recorded: somebody ran `run --scheduled` by hand, and a hand-run is due.
  const time = record ? parseTimeOfDay(record.time) : null;
  if (!time) return true;

  const occurrence = new Date(now);
  occurrence.setHours(time.hour, time.minute, 0, 0);
  // Before today's time, the occurrence to satisfy is yesterday's.
  if (occurrence > now) occurrence.setDate(occurrence.getDate() - 1);

  if (!lastRun?.ok) return true;
  const lastAt = Date.parse(lastRun.at);
  if (!Number.isFinite(lastAt)) return true;
  return lastAt < occurrence.getTime();
}

export async function loadLastRun(): Promise<LastRun | null> {
  // Only a report: a damaged one is shown as no report, and the next run writes a new one.
  const stored = await readJsonFile<LastRun>(lastRunPath()).catch((error: unknown) => {
    if (error instanceof UnreadableFileError) return null;
    throw error;
  });
  if (!stored || typeof stored.at !== 'string') return null;
  return stored;
}

// ------------------------------------------------------------------ where things live

function logDir(env: Resolved): string {
  // Redirectable, for the same reason the config and archive directories are — and this one
  // is not merely tidiness. The daily log records a run in the tool's own words, which
  // means it records a child's NAME ("Looking for Robin's photos") and the archive path.
  // The setup page now shows the tail of it, and scripts/screenshots.js drives that page to
  // produce pictures that are committed to a public repository. Without this override the
  // screenshot script would read the developer's real log and publish a real child's name.
  // Set by scripts/test-env.js and by the screenshot script; nothing in the product sets it.
  const override = process.env.CARE_ALBUM_LOG_DIR;
  if (override) return override;
  switch (env.platform) {
    case 'darwin':
      return join(env.home, 'Library', 'Logs', 'care-album-saver');
    case 'win32':
      return join(configDir(), 'logs');
    default:
      return join(env.home, '.local', 'state', 'care-album-saver');
  }
}

/**
 * The one log this tool owns, on every platform.
 *
 * Each scheduler has a logging facility and none of them has the same one. launchd takes
 * StandardOutPath and writes a file. systemd sends a unit's output to the journal, which is
 * the right place on that machine and is read with `journalctl --user`. cron mails output
 * to the user unless it is redirected, which on a desktop means it vanishes. Task Scheduler
 * records that a task ran and with what exit code, but not a word the task printed.
 *
 * So: the platform's own facility gets the output wherever it has one — the systemd unit is
 * left un-redirected on purpose so the journal receives it — and in addition every
 * scheduled run appends one line here. That is the only way "show me why last night failed"
 * can be answered the same way on four platforms, and the only way it can be answered at
 * all on Windows.
 */
export const logFile = (env: ScheduleEnvironment = {}): string => join(logDir(resolveEnv(env)), 'daily.log');

/**
 * The tail of that log, for the page to show. Scrubbed, like everything else a page sees.
 *
 * Bounded by lines rather than by bytes so that one enormous line cannot be used to make
 * this read a whole disk into memory, and the file is opened read-only and closed.
 */
export async function readLog(lines = 200, env: ScheduleEnvironment = {}): Promise<{ path: string; text: string }> {
  const path = logFile(env);
  try {
    const text = await readFile(path, 'utf8');
    const tail = text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
    return { path, text: scrub(tail) };
  } catch {
    return { path, text: '' };
  }
}

/**
 * Append one line, stamped with when it was written. Never throws: a log that cannot be
 * written must not fail the run.
 */
export async function appendLog(line: string, env: ScheduleEnvironment = {}): Promise<void> {
  const e = resolveEnv(env);
  try {
    await mkdir(logDir(e), { recursive: true, mode: 0o700 });
    // Owner-only: these lines name a child and the folder their photographs are in, so the
    // log gets the session file's treatment rather than a world-readable default.
    await appendFile(logFile(env), `${logTimestamp()}  ${scrub(line)}\n`, { encoding: 'utf8', mode: 0o600 });
    // The create mode above only applies to a file this call creates. launchd creates the
    // same file first, from the job's own output, at 0644 — so it is put right every time.
    if (e.platform !== 'win32') {
      await chmod(logFile(env), 0o600);
      await chmod(logDir(e), 0o700);
    }
  } catch {
    /* A missing log is not worth failing a run over. */
  }
}

/**
 * Open the platform's own log viewer, so the answer is not only this page's textarea.
 *
 * macOS has Console.app, which reads the file launchd wrote. A systemd machine has the
 * journal, and `journalctl --user -u <unit>` is where a Linux user would already look —
 * there is no GUI to open, so the page shows the command rather than pretending. Windows
 * records task history in Event Viewer. Where a platform has no viewer this returns the
 * command a person would type, which is more use than a disabled button.
 */
export async function openLogs(env: ScheduleEnvironment = {}): Promise<{ opened: boolean; hint: string }> {
  const e = resolveEnv(env);
  const path = logFile(env);
  if (e.platform === 'darwin') {
    const r = await e.run('open', ['-a', 'Console', path]);
    return { opened: r.code === 0, hint: r.code === 0 ? '' : `Open this file to read it: ${path}` };
  }
  if (e.platform === 'win32') {
    // Task Scheduler's own history, which is where Windows records that the job ran at all.
    const r = await e.run('cmd', ['/c', 'start', '', 'taskschd.msc']);
    return { opened: r.code === 0, hint: `Task Scheduler keeps its own history; this tool's log is at ${path}` };
  }
  const mechanism = (await loadConfig()).schedule?.mechanism;
  if (mechanism === 'systemd') {
    return { opened: false, hint: `The system journal has it: journalctl --user -u ${SYSTEMD_UNIT} -n 200` };
  }
  const r = await e.run('xdg-open', [path]);
  return { opened: r.code === 0, hint: r.code === 0 ? '' : `Open this file to read it: ${path}` };
}

const plistPath = (env: Resolved): string => join(env.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const systemdDir = (env: Resolved): string => join(env.home, '.config', 'systemd', 'user');
const timerPath = (env: Resolved): string => join(systemdDir(env), `${SYSTEMD_UNIT}.timer`);
const servicePath = (env: Resolved): string => join(systemdDir(env), `${SYSTEMD_UNIT}.service`);

/**
 * Which scheduler this machine gets.
 *
 * Only the Linux answer is a question: systemd is on most desktops but by no means all, and
 * a user timer on a machine without a user systemd instance would install silently and
 * never fire. Asking `systemctl` whether it is there costs one command and is the only
 * honest way to decide — so the answer is reported back to the parent rather than assumed.
 */
async function chooseMechanism(env: ScheduleEnvironment = {}): Promise<ScheduleMechanism> {
  const e = resolveEnv(env);
  if (e.platform === 'darwin') return 'launchd';
  if (e.platform === 'win32') return 'schtasks';
  const probe = await e.run('systemctl', ['--user', '--version']);
  return probe.code === 0 ? 'systemd' : 'cron';
}

// ------------------------------------------------------------------ the job descriptions

/** `&`, `<` and `>` are legal in a folder name and would otherwise break the plist. */
function xml(value: string): string {
  return value.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
}

/**
 * One word for /bin/sh: single quotes, inside which nothing at all is special except the
 * closing quote, so `$(…)`, backticks, `"` and `\` are only letters. A `'` in the path ends
 * the quoted part, is written as `\'`, and starts another: `'\''`.
 */
function shellWord(value: string): string {
  return `'${value.replace(/'/g, () => `'\\''`)}'`;
}

/**
 * One word of a crontab line (security review processes-1).
 *
 * A crontab line is read by cron before the shell sees it, and cron has a meaning of its own
 * for `%`: cronie and the Vixie cron Debian ships end the command at the first `%`, turn the
 * rest into the job's input, and strip the backslash from `\%`; BusyBox's crond, which Alpine
 * uses, passes both through untouched. No spelling of a literal `%` means the same to all of
 * them, so none is written. Each `%` in a path is made by the shell instead, from printf's
 * octal escape, outside the single quotes — and the line then holds no `%` for any cron to
 * read. A path with no `%` in it, which is nearly every path, is just shellWord.
 */
function cronWord(value: string): string {
  return value.split('%').map(shellWord).join(`"$(printf '\\045')"`);
}

/**
 * One word of a systemd ExecStart= line (security review processes-1).
 *
 * systemd reads the word three times. Its own quoting first: inside double quotes it takes
 * C escapes, so `\` and `"` are escaped. Then `%` specifiers (`%h` is the home folder), where
 * `%%` is a percent sign — on the program's path and on every argument. Then `$` variables,
 * where `$$` is a dollar sign — on the arguments only: systemd executes the path it parsed
 * (find_executable_full on command->path in exec-invoke.c) and substitutes variables in argv
 * alone, so doubling a `$` in the program's path would name a file that does not exist.
 * argv[0] is substituted, but Node finds itself through the operating system rather than
 * through argv[0], so a `$` there costs at most a line in the journal.
 */
function systemdWord(value: string, argument: boolean): string {
  let word = value.replace(/[\\"]/g, (c) => `\\${c}`).replace(/%/g, () => '%%');
  if (argument) word = word.replace(/\$/g, () => '$$');
  return `"${word}"`;
}

/**
 * One argument of a Windows command line, spelled so that the C runtime's parser, which is
 * how node.exe reads its arguments, gives it back unchanged (security review processes-1).
 *
 * Inside double quotes a backslash is a letter unless backslashes run up to a `"`, where
 * each pair becomes one; so a run of them is doubled before a quote and before the closing
 * quote, and a quote in the value is escaped. Windows forbids `"` in a file name and this
 * path ends in `cli.js`, so today this is always the path in quotes — which is the point:
 * the day either stops being true, the argument still arrives whole.
 */
function windowsArg(value: string): string {
  const escaped = value.replace(/(\\*)"/g, (_, slashes: string) => `${slashes}${slashes}\\"`);
  return `"${escaped.replace(/(\\+)$/, (_, slashes: string) => `${slashes}${slashes}`)}"`;
}

/**
 * Control characters: C0, DEL and C1. A line break ends a crontab line or a unit file's
 * setting part-way through a path, and XML — the plist, the task — cannot carry most of the
 * rest at all, so no scheduler here can be handed a path that holds one.
 */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Refuse, before anything is written, a path the chosen scheduler cannot be trusted to read
 * back exactly (security review processes-1).
 *
 * The daily log's path is in the job only for launchd (StandardOutPath) and cron (the
 * redirect); systemd sends the output to the journal and Task Scheduler keeps none.
 *
 * Task Scheduler reads the part of a command or its arguments between two `%` signs as the
 * name of an environment variable and puts its value in its place, and has no escape for it.
 * Which spans it would read that way depends on the variables of the moment, so a path with
 * two `%` signs in it is refused outright; one `%` has nothing to pair with and is left alone.
 */
function assertSchedulable(e: Resolved, mechanism: ScheduleMechanism): void {
  const paths: Array<[string, string]> = [
    ['Node', e.nodePath],
    ['this tool', e.cliPath],
  ];
  if (mechanism === 'launchd' || mechanism === 'cron') paths.push(['the daily log', join(logDir(e), 'daily.log')]);
  for (const [what, path] of paths) {
    if (CONTROL_CHARACTER.test(path)) {
      throw new Error(
        `The daily run cannot be set up, and nothing was changed: the path to ${what} has a line break or another ` +
          `invisible character in it, which the scheduler would misread — ${JSON.stringify(path)}. ` +
          'Rename that folder, or move it somewhere whose name has none, and turn the daily run on again.',
      );
    }
    if (mechanism === 'schtasks' && what !== 'the daily log' && /%.*%/.test(path)) {
      throw new Error(
        `The daily run cannot be set up, and nothing was changed: the path to ${what} has two % signs in it, and ` +
          'Task Scheduler would read the part between them as the name of a Windows setting and replace it — ' +
          `${path}. Rename that folder, or move it somewhere whose name has at most one %, and turn the daily run on again.`,
      );
    }
  }
}

function launchAgentPlist(env: Resolved, time: TimeOfDay): string {
  const log = join(logDir(env), 'daily.log');
  const args = [env.nodePath, env.cliPath, ...RUN_ARGS].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    // The daily trigger. launchd runs a missed one when the Mac wakes, which is the whole
    // reason for preferring it to cron on a laptop that is shut at 7pm.
    '  <key>StartCalendarInterval</key>',
    '  <dict>',
    `    <key>Hour</key><integer>${time.hour}</integer>`,
    `    <key>Minute</key><integer>${time.minute}</integer>`,
    '  </dict>',
    // At login as well, and this is the powered-OFF case rather than the asleep one.
    //
    // launchd's own words for sleep: "Unlike cron which skips job invocations when the
    // computer is asleep, launchd will start the job the next time the computer wakes up.
    // If multiple intervals transpire before the computer is woken, those events will be
    // coalesced into one event upon wake from sleep." That covers a closed lid. It does
    // not cover a Mac that was shut down at six and turned on the next morning, because
    // the agent is loaded fresh at login with no memory of the interval it missed.
    //
    // RunAtLoad closes that, and the man page's objection to it — speculative launches
    // hurting login performance — is answered by the run itself rather than by not doing
    // it: `run --scheduled` asks `isDue` first and exits in milliseconds when the last
    // successful run already covers the most recent occurrence. So this costs a process
    // start at login, not a sync.
    '  <key>RunAtLoad</key>',
    '  <true/>',
    // Background: launchd may then give it less CPU and less disk priority than whatever
    // the person is actually doing, which is right for an archive job.
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    // Owner-only, for everything the job creates — the log above all. launchd opens
    // StandardOutPath itself, before this tool runs, with its own default of 0644, and the
    // run's output names each child. Umask 077 (63 in decimal, which is what launchd reads).
    '  <key>Umask</key>',
    '  <integer>63</integer>',
    // Turning the daily run off, changing its time or reinstalling it stops a run in progress
    // with SIGTERM. The run then finishes the photo it is on and writes down what it saved;
    // launchd's default twenty seconds before SIGKILL can cut that short on a large video.
    '  <key>ExitTimeOut</key>',
    '  <integer>60</integer>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(log)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(log)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function systemdService(env: Resolved): string {
  return [
    '[Unit]',
    'Description=Save new Brightwheel photos to this computer',
    '',
    '[Service]',
    'Type=oneshot',
    // Double quotes carry a home folder with a space in it; systemdWord escapes what systemd
    // would otherwise read inside them (security review processes-1).
    `ExecStart=${systemdWord(env.nodePath, false)} ${systemdWord(env.cliPath, true)} ${RUN_ARGS.join(' ')}`,
    '',
  ].join('\n');
}

export function systemdTimer(time: TimeOfDay): string {
  return [
    '[Unit]',
    'Description=Save new Brightwheel photos once a day',
    '',
    '[Timer]',
    `OnCalendar=*-*-* ${pad(time.hour)}:${pad(time.minute)}:00`,
    // A run missed because the machine was off happens once it is on again, rather than
    // being skipped until tomorrow.
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

export function cronLines(env: Resolved, time: TimeOfDay): string[] {
  // Two lines, because cron is the one scheduler here with no catch-up of its own. The
  // daily line is the schedule; the @reboot line is what makes a run missed while the
  // machine was off happen once it is on again — the behaviour launchd gives for free and
  // systemd gives with Persistent=true. `run --scheduled` exits immediately when the most
  // recent occurrence is already covered, so this is not "a run on every boot".
  return [cronLine(env, time), rebootLine(env)];
}

/** The catch-up line. `@reboot` is in every cron implementation this tool will meet. */
function rebootLine(env: Resolved): string {
  return `@reboot ${cronCommand(env)}`;
}

function cronLine(env: Resolved, time: TimeOfDay): string {
  return `${time.minute} ${time.hour} * * * ${cronCommand(env)}`;
}

/**
 * What both lines run, as the shell will read it. Every path goes through cronWord, because
 * cron hands this text to /bin/sh, and double quotes alone left `$(…)`, backticks, `"` and
 * `%` live (security review processes-1).
 */
function cronCommand(env: Resolved): string {
  const log = join(logDir(env), 'daily.log');
  return `${cronWord(env.nodePath)} ${cronWord(env.cliPath)} ${RUN_ARGS.join(' ')} >> ${cronWord(log)} 2>&1`;
}

/**
 * The task, as Task Scheduler's own XML.
 *
 * `schtasks /Create` has flags for the trigger and the command and for almost nothing
 * else, and the three settings that matter here are among the nothing else:
 *
 *  - **StartWhenAvailable** is the missed-run catch-up, and the reason this function
 *    exists. Microsoft: "the Task Scheduler can start the task at any time after its
 *    scheduled time has passed", queued "after a delay. The default delay is 10 minutes."
 *    Their documentation adds that it "applies only to time-based tasks with an end
 *    boundary or time-based tasks that are set to repeat infinitely", which a plain daily
 *    trigger satisfies by repeating without end.
 *  - **DisallowStartIfOnBatteries** defaults to TRUE in Task Scheduler. On a parent's
 *    laptop that default means the evening run simply does not happen, which is exactly
 *    the silent failure this whole change is about. Both battery settings are turned off.
 *  - **MultipleInstancesPolicy** IgnoreNew, so a catch-up firing while yesterday's run is
 *    somehow still going does not start a second one against the same folder.
 *
 * Nothing a parent types reaches this. The only substituted values are the two absolute
 * paths the machine gave us and the time, and each is XML-escaped on the way in. The tool's
 * path is also an argument on a command line, so it is quoted for the C runtime that splits
 * it (windowsArg), and a path in which Task Scheduler would expand a `%NAME%` never gets
 * this far (assertSchedulable).
 */
export function schtasksXml(env: Resolved, time: TimeOfDay): string {
  // Task Scheduler wants a start boundary; the date is only an anchor for a daily
  // recurrence, so any past date does. A fixed one keeps the file reproducible.
  const start = `2026-01-01T${pad(time.hour)}:${pad(time.minute)}:00`;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>Saves new photos from Brightwheel into your photos folder.</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <CalendarTrigger>',
    `      <StartBoundary>${start}</StartBoundary>`,
    '      <Enabled>true</Enabled>',
    '      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>',
    '    </CalendarTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <ExecutionTimeLimit>PT4H</ExecutionTimeLimit>',
    '    <Enabled>true</Enabled>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xml(env.nodePath)}</Command>`,
    `      <Arguments>${xml(`${windowsArg(env.cliPath)} ${RUN_ARGS.join(' ')}`)}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

// ------------------------------------------------------------------ install

export interface ScheduleStatus {
  /** Whether this tool's own schedule is set up. */
  installed: boolean;
  mechanism: ScheduleMechanism | null;
  /** `HH:MM` on this computer's clock. */
  time: string | null;
  /** Registered and old enough to have run, but nothing has. See `status`. */
  overdue?: boolean;
  /** The next time it will run, ISO 8601, or null when nothing is scheduled. */
  nextRun: string | null;
  lastRun: LastRun | null;
  /**
   * What the operating system's own scheduler says when asked whether it knows this job.
   * `null` when nothing is installed, so there was nothing to ask about.
   */
  registered: boolean | null;
  /** The file or entry holding it, so it can be found without this tool. */
  location: string | null;
  /** One or two sentences for the parent, in their words. */
  summary: string;
}

/**
 * The daily run belongs to another copy of this tool, and that copy is still there.
 *
 * Every copy on a computer shares one settings folder and one job name, so whichever copy
 * last set up the daily run is the one it runs. Before this, a throwaway copy — an unpacked
 * download looked at once, an npx cache, a second clone — that was asked to "turn on the
 * daily run", or whose setup page had the time changed, quietly re-pointed the real job at
 * itself (security review, missed-web). Now the copy that set it up is written down, and
 * another copy takes it over only when told to: the setup page asks the parent first, the
 * command line needs --replace. A production copy's job is never taken from the page at
 * all, and only the command line's --replace takes it; deploying moves it.
 */
export class ScheduleOwnedElsewhereError extends Error {
  /**
   * @param owner the other copy's `cli.js`, absolute.
   * @param shown the folder it is in, as a person reads it.
   */
  constructor(public readonly owner: string, public readonly production: boolean, shown: string = owner) {
    super(
      production
        ? `The daily run belongs to the production copy of this tool, in ${shown}, and this copy leaves it alone. ` +
            'Deploying (node scripts/deploy.js) is what moves it.'
        : `The daily run was set up by another copy of this tool, in ${shown}, and runs that copy. ` +
            'Change it from there, or have this copy take it over.',
    );
    this.name = 'ScheduleOwnedElsewhereError';
  }
}

export interface OwnershipOptions {
  /** Take over a daily run another copy set up. The setup page sends it only once the parent agrees. */
  replace?: boolean;
  /** Also take over, or turn off, a production copy's. The command line's --replace; the page never sends it. */
  replaceProduction?: boolean;
}

/** The folder a copy's `cli.js` belongs to: dist → the package → packages → the repository. */
function copyRoot(cliPath: string): string {
  return resolve(dirname(cliPath), '..', '..', '..');
}

function isProductionCopy(cliPath: string): boolean {
  return isProductionRoot(copyRoot(cliPath));
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync.native(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

/**
 * Refuse to change a daily run that runs another copy, unless told to. A copy that no longer
 * exists owns nothing — its job cannot run — and a record from before copies were written
 * down names no owner, so neither stops anything. The production copy may take it from any
 * copy that is not production: that is what deploying does. From another production copy —
 * the folder production was before a `deploy.js --to` — only deploy.js, which says --replace.
 */
function assertMayChange(record: ScheduleRecord | null, e: Resolved, options: OwnershipOptions, action: 'install' | 'remove'): void {
  // The settings file can be edited by hand; anything but a path names no owner.
  const owner = typeof record?.cliPath === 'string' && record.cliPath !== '' ? record.cliPath : null;
  if (!owner || samePath(owner, e.cliPath) || !existsSync(owner)) return;
  const production = isProductionCopy(owner);
  if (!production && isProductionCopy(e.cliPath)) return;
  if (production ? options.replaceProduction : action === 'remove' || options.replace || options.replaceProduction) return;
  // The package folder, not `dist/cli.js`, and from the home folder where it is under it.
  const folder = resolve(dirname(owner), '..');
  const shown = e.platform !== 'win32' && folder.startsWith(e.home + sep) ? `~${folder.slice(e.home.length)}` : folder;
  throw new ScheduleOwnedElsewhereError(owner, production, shown);
}

/**
 * Install or move the daily run. Idempotent: running it twice leaves one job, not two.
 *
 * Every mechanism below replaces rather than appends — the plist and the unit files are
 * overwritten, `schtasks /F` overwrites, and the crontab is rewritten with our marked block
 * removed first. That is what makes "change the time" the same operation as "set it up",
 * which in turn is what stops a parent who changed their mind twice from having three
 * copies of the job running at three different times.
 */
export async function install(timeInput: string, env: ScheduleEnvironment = {}, options: OwnershipOptions = {}): Promise<ScheduleStatus> {
  const time = parseTimeOfDay(timeInput);
  if (!time) {
    throw new Error(`"${timeInput}" is not a time of day. Give it as HH:MM on a 24-hour clock, for example 19:00.`);
  }
  const e = resolveEnv(env);
  assertMayChange((await loadConfig()).schedule, e, options, 'install');
  const mechanism = await chooseMechanism(env);
  assertSchedulable(e, mechanism);
  await mkdir(logDir(e), { recursive: true });

  let location: string;
  switch (mechanism) {
    case 'launchd': {
      location = plistPath(e);
      await mkdir(join(e.home, 'Library', 'LaunchAgents'), { recursive: true });
      await writeFile(location, launchAgentPlist(e, time), 'utf8');
      // Unload first: launchd refuses to bootstrap a label it already has, so without this
      // a change of time would write a new plist that nothing ever read.
      await e.run('launchctl', ['bootout', `gui/${e.uid}/${LAUNCHD_LABEL}`]);
      const loaded = await e.run('launchctl', ['bootstrap', `gui/${e.uid}`, location]);
      if (loaded.code !== 0) {
        throw new Error(
          `The daily run was written to ${location} but macOS would not start it: ` +
            `${loaded.stderr.trim() || `launchctl exited with ${loaded.code}`}.`,
        );
      }
      break;
    }
    case 'systemd': {
      location = timerPath(e);
      await mkdir(systemdDir(e), { recursive: true });
      await writeFile(servicePath(e), systemdService(e), 'utf8');
      await writeFile(location, systemdTimer(time), 'utf8');
      await e.run('systemctl', ['--user', 'daemon-reload']);
      const enabled = await e.run('systemctl', ['--user', 'enable', '--now', `${SYSTEMD_UNIT}.timer`]);
      if (enabled.code !== 0) {
        throw new Error(
          `The daily run was written to ${location} but systemd would not start it: ` +
            `${enabled.stderr.trim() || `systemctl exited with ${enabled.code}`}.`,
        );
      }
      break;
    }
    case 'cron': {
      location = 'your crontab (see "crontab -l")';
      const kept = stripCronBlock(await currentCrontab(e));
      const written = `${[...kept, CRON_MARKER, ...cronLines(e, time), CRON_END].join('\n')}\n`;
      const applied = await e.run('crontab', ['-'], written);
      if (applied.code !== 0) {
        throw new Error(`The daily run could not be added to your crontab: ${applied.stderr.trim() || `crontab exited with ${applied.code}`}.`);
      }
      break;
    }
    case 'schtasks': {
      location = `Task Scheduler, under "${SCHTASKS_NAME}"`;
      // /F overwrites a task of the same name, which is what makes this idempotent.
      // Registered from XML rather than from flags, because the setting that makes a
      // missed run happen at all has no flag. See schtasksXml. UTF-16LE with a BOM is what
      // Task Scheduler writes and the encoding schtasks reads most reliably.
      const xmlPath = join(tmpdir(), `care-album-saver-task-${process.pid}.xml`);
      // Cleared first and then created exclusively, so a file or link left at this name —
      // by a crashed run whose pid was reused, or by anything else — is never written through.
      await rm(xmlPath, { force: true });
      await writeFile(xmlPath, `\ufeff${schtasksXml(e, time)}`, { encoding: 'utf16le', flag: 'wx' });
      let created;
      try {
        created = await e.run('schtasks', ['/Create', '/TN', SCHTASKS_NAME, '/XML', xmlPath, '/F']);
      } finally {
        // The file holds two paths and no secret, but it is still this tool's litter.
        await rm(xmlPath, { force: true }).catch(() => {});
      }
      if (created.code !== 0) {
        throw new Error(`Windows Task Scheduler refused the daily run: ${created.stderr.trim() || `schtasks exited with ${created.code}`}.`);
      }
      break;
    }
  }

  const record: ScheduleRecord = {
    time: formatTimeOfDay(time),
    mechanism,
    location,
    installedAt: new Date().toISOString(),
    fragilePath:
      EPHEMERAL.test(e.nodePath) || KEG.test(e.nodePath) ? e.nodePath : EPHEMERAL.test(e.cliPath) ? e.cliPath : null,
    cliPath: e.cliPath,
  };
  const config = await loadConfig();
  await saveConfig({ ...config, schedule: record });
  return status(env);
}

/**
 * Take the daily run away. Idempotent: removing one that is not there is not an error, and
 * says so plainly rather than reporting a failure a parent would have to interpret.
 */
export async function remove(env: ScheduleEnvironment = {}, options: OwnershipOptions = {}): Promise<ScheduleStatus> {
  const e = resolveEnv(env);
  // Turning the daily run off must work when the settings cannot be read: it is the first
  // thing to do about damaged settings, because the job would otherwise go on starting every
  // evening only to refuse. Then the scheduler is asked directly and the settings are left
  // exactly as they are — writing them would replace what is there with the defaults.
  let config: Config | null = null;
  try {
    config = await loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigUnusableError)) throw error;
  }
  // Turning off another copy's daily run is allowed — it is the safe direction — except a
  // production copy's, which a stray copy must not be able to silence.
  assertMayChange(config?.schedule ?? null, e, options, 'remove');
  // Whatever installed it is what has to remove it — a machine that has since gained
  // systemd must still be able to clear the crontab line left by the version that had not.
  const mechanism = config?.schedule?.mechanism ?? (await chooseMechanism(env));

  switch (mechanism) {
    case 'launchd':
      await e.run('launchctl', ['bootout', `gui/${e.uid}/${LAUNCHD_LABEL}`]);
      await rm(plistPath(e), { force: true });
      break;
    case 'systemd':
      await e.run('systemctl', ['--user', 'disable', '--now', `${SYSTEMD_UNIT}.timer`]);
      await rm(timerPath(e), { force: true });
      await rm(servicePath(e), { force: true });
      await e.run('systemctl', ['--user', 'daemon-reload']);
      break;
    case 'cron': {
      const kept = stripCronBlock(await currentCrontab(e));
      // Their own lines go back exactly as they were; only ours are gone.
      const cleared = await e.run('crontab', ['-'], kept.length > 0 ? `${kept.join('\n')}\n` : '');
      if (cleared.code !== 0) {
        throw new Error(`The daily run could not be removed from your crontab, so nothing was changed: ${cleared.stderr.trim() || `crontab exited with ${cleared.code}`}.`);
      }
      break;
    }
    case 'schtasks':
      await e.run('schtasks', ['/Delete', '/TN', SCHTASKS_NAME, '/F']);
      break;
  }

  if (!config) {
    return {
      installed: false,
      mechanism: null,
      time: null,
      nextRun: null,
      lastRun: await loadLastRun(),
      registered: null,
      location: null,
      summary: 'The daily run is off. Your settings still cannot be read, and have been left as they are.',
    };
  }
  await saveConfig({ ...(await loadConfig()), schedule: null });
  return status(env);
}

/**
 * Everything the tool knows about the daily run.
 *
 * The configuration says what was asked for; the operating system says whether it is really
 * there. Both are reported, because they can disagree — a parent who deleted the plist by
 * hand, a Windows profile restored without its scheduled tasks — and a tool that showed only
 * its own record would promise a nightly run that stopped weeks ago.
 */
export async function status(env: ScheduleEnvironment = {}): Promise<ScheduleStatus> {
  const e = resolveEnv(env);
  const config = await loadConfig();
  const lastRun = await loadLastRun();
  const record = config.schedule;

  if (!record) {
    return {
      installed: false,
      mechanism: null,
      time: null,
      nextRun: null,
      lastRun,
      registered: null,
      location: null,
      summary: 'Photos are not being saved automatically. You can start it yourself whenever you like.',
    };
  }

  const time = parseTimeOfDay(record.time);
  const next = time ? nextOccurrence(time) : null;
  const registered = await isRegistered(e, record.mechanism);

  const when = time ? spokenTime(time) : record.time;

  /**
   * A job that is registered, is old enough to have run, and never has.
   *
   * This is the quiet failure: the scheduler holds the entry, the setup page says the
   * daily run is on, and nothing happens — because the Node binary or this tool's entry
   * point moved (see EPHEMERAL), or because the job was installed on a laptop that has
   * been shut at seven every evening since. A day of grace past the first occurrence
   * after installation, so a job set up this afternoon is not accused of anything.
   */
  const installedAt = Date.parse(record.installedAt ?? '');
  // The scheduler's own last run, not the last run of any kind: see LastRun.scheduledAt.
  const lastAt = lastRun ? Date.parse(lastRun.scheduledAt ?? (lastRun.trigger === 'schedule' ? lastRun.at : '')) : NaN;
  const dueSince = Number.isFinite(installedAt) ? installedAt + 2 * 24 * 3600 * 1000 : NaN;
  const overdue =
    registered !== false &&
    Number.isFinite(dueSince) &&
    Date.now() > dueSince &&
    (!Number.isFinite(lastAt) || lastAt < Date.now() - 2 * 24 * 3600 * 1000);

  const sinceInstall = Number.isFinite(installedAt)
    ? Math.floor((Date.now() - installedAt) / (24 * 3600 * 1000))
    : null;
  const summary = registered === false
    ? `A daily run at ${when} was set up on this computer, but it is no longer there — something removed it. Turn it on again below.`
    : overdue
      ? `A daily run at ${when} is set up${sinceInstall === null ? '' : ` — ${sinceInstall} days ago`}, but it has not saved anything yet. ` +
        (record.fragilePath
          ? 'That usually means the program it points at has moved, which happens when Node is upgraded or a temporary copy is cleaned up. Turn it off and on again below to point it at the current one.'
          : 'Either the computer has been off or asleep at that time every day, or the program it points at has moved. Turn it off and on again below to point it at the current one.')
      : `Photos are saved automatically every day at ${when}. This only happens while the computer is on and signed in.`;

  return {
    installed: true,
    mechanism: record.mechanism,
    time: record.time,
    nextRun: next ? next.toISOString() : null,
    lastRun,
    registered,
    location: record.location,
    overdue,
    summary,
  };
}

/** Whether the platform's scheduler itself still knows the job. */
async function isRegistered(e: Resolved, mechanism: ScheduleMechanism): Promise<boolean> {
  switch (mechanism) {
    case 'launchd':
      return (await e.run('launchctl', ['print', `gui/${e.uid}/${LAUNCHD_LABEL}`])).code === 0;
    case 'systemd':
      return (await e.run('systemctl', ['--user', 'is-enabled', `${SYSTEMD_UNIT}.timer`])).code === 0;
    case 'schtasks':
      return (await e.run('schtasks', ['/Query', '/TN', SCHTASKS_NAME])).code === 0;
    case 'cron': {
      const existing = await e.run('crontab', ['-l']);
      if (existing.code !== 0) return false;
      return existing.stdout.split(/\r?\n/).some((line) => line.trim() === CRON_MARKER);
    }
  }
}

/** "7:00 in the evening" rather than "19:00", which is not how a parent reads a clock. */
function spokenTime(time: TimeOfDay): string {
  const hour12 = time.hour % 12 === 0 ? 12 : time.hour % 12;
  const part = time.hour < 12 ? 'in the morning' : time.hour < 18 ? 'in the afternoon' : 'in the evening';
  return `${hour12}:${pad(time.minute)} ${part}`;
}

/**
 * The person's crontab, or nothing when they have none. "no crontab for <user>" is the
 * ordinary state of a machine nobody has scheduled anything on; any other failure to read it
 * is exactly that, a failure — treating it as empty and writing back would replace whatever
 * lines they had with ours alone (found by the 2026-09-23 security review).
 */
async function currentCrontab(e: Resolved): Promise<string> {
  const existing = await e.run('crontab', ['-l']);
  if (existing.code === 0) return existing.stdout;
  if (/no crontab for/i.test(existing.stderr)) return '';
  throw new Error(`Your crontab could not be read, so nothing was changed: ${existing.stderr.trim() || `crontab exited with ${existing.code}`}.`);
}

/**
 * A crontab with our block taken out.
 *
 * The block runs from CRON_MARKER to CRON_END. Trailing blank lines go too, so that
 * installing and removing repeatedly does not grow the file a line at a time.
 */
function stripCronBlock(crontab: string): string[] {
  const lines = crontab.split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (line !== CRON_MARKER) {
      kept.push(lines[i] ?? '');
      continue;
    }
    // A block whose CRON_END was deleted by hand loses only the marker and the line after
    // it. Reading on to the end of the file instead could take the person's own lines with
    // it, and those are the one thing removing must never touch.
    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]?.trim() === CRON_END) { end = j; break; }
      if (lines[j]?.trim() === CRON_MARKER) break;
    }
    i = end === -1 ? i + 1 : end;
  }
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === '') kept.pop();
  return kept;
}

/**
 * Read back what a scheduled job would be, without installing anything.
 *
 * The setup page shows this before the parent agrees to it: a job that runs unattended
 * every day should not be a thing that happens invisibly when a switch is flicked.
 */
export async function describe(timeInput: string, env: ScheduleEnvironment = {}): Promise<{
  mechanism: ScheduleMechanism;
  location: string;
  command: string;
}> {
  const time = parseTimeOfDay(timeInput) ?? { hour: 19, minute: 0 };
  const e = resolveEnv(env);
  const mechanism = await chooseMechanism(env);
  const location =
    mechanism === 'launchd'
      ? plistPath(e)
      : mechanism === 'systemd'
        ? timerPath(e)
        : mechanism === 'cron'
          ? 'your crontab (see "crontab -l")'
          : `Task Scheduler, under "${SCHTASKS_NAME}"`;
  const command =
    mechanism === 'cron' ? cronLine(e, time) : `"${e.nodePath}" "${e.cliPath}" ${RUN_ARGS.join(' ')}`;
  return { mechanism, location, command };
}
