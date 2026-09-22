import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, readJsonFile, writeSecureFile } from './paths.js';
import { loadConfig, saveConfig, type ScheduleMechanism, type ScheduleRecord } from './config.js';

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
 * Two rules hold everywhere in this file.
 *
 * Every command is run with `execFile` and an argument array — never a shell string, and
 * never `exec`. The paths that go into these commands come from the machine (`execPath`,
 * the home directory) rather than from anything a parent types, but an archive tool that
 * builds shell commands out of filesystem paths is one oddly-named home folder away from
 * running something it did not mean to, and the argument array makes that unrepresentable.
 *
 * And nothing here goes near `npx`. The README has to warn people that a scheduled job
 * cannot find a bare `npx` (its PATH is almost empty) and that Windows needs `npx.cmd`
 * rather than `npx`, because that is the advice for someone writing the crontab line by
 * hand. When the tool writes the entry itself it can do better: it records the absolute
 * path of the Node binary running right now and the absolute path of this tool's own
 * command-line entry point, so there is no PATH lookup, no shim, and nothing to get wrong.
 */

/** The label, unit and task name. One job, one name, on every platform. */
const LAUNCHD_LABEL = 'com.care-album-saver.daily';
const SYSTEMD_UNIT = 'care-album-saver';
const SCHTASKS_NAME = 'Care Album Saver daily';

/**
 * The first line of the crontab block this tool owns.
 *
 * A crontab belongs to the person, not to us: it may well hold lines they wrote themselves.
 * So installing rewrites only the lines between this marker and the line after it, and
 * removing takes only those away. Anything unmarked is copied through untouched.
 */
const CRON_MARKER = '# care-album-saver: the daily run. Delete these two lines to stop it.';

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
  /** The Node binary the scheduled run should use. Defaults to the one running now. */
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
    nodePath: env.nodePath ?? process.execPath,
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
const EPHEMERAL = /[\/\\](?:\.nvm|\.volta|\.fnm|_npx|\.pnpm-store)[\/\\]|[\/\\]dlx-/i;

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
  const e = resolveEnv(env);
  const title = 'Care Album Saver';
  try {
    if (e.platform === 'darwin') {
      // The message is a literal here, never interpolated from an error: this is
      // AppleScript source, and the argument array does not protect its contents.
      const script = message === FAILED_NOTICE
        ? `display notification "The daily photo run did not work. Open the setup assistant to see why." with title "${title}"`
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

/** The one notice this tool sends. Fixed text, so nothing about a family can reach it. */
export const FAILED_NOTICE = 'The daily photo run did not work. Open the setup assistant to see why.';

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
export const formatTimeOfDay = (t: TimeOfDay): string => `${pad(t.hour)}:${pad(t.minute)}`;

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
}

export const lastRunPath = (): string => join(configDir(), 'last-run.json');

export async function recordRun(run: LastRun): Promise<void> {
  await writeSecureFile(lastRunPath(), JSON.stringify(run, null, 2));
}

export async function loadLastRun(): Promise<LastRun | null> {
  const stored = await readJsonFile<LastRun>(lastRunPath());
  if (!stored || typeof stored.at !== 'string') return null;
  return stored;
}

// ------------------------------------------------------------------ where things live

function logDir(env: Resolved): string {
  switch (env.platform) {
    case 'darwin':
      return join(env.home, 'Library', 'Logs', 'care-album-saver');
    case 'win32':
      return join(configDir(), 'logs');
    default:
      return join(env.home, '.local', 'state', 'care-album-saver');
  }
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
export async function chooseMechanism(env: ScheduleEnvironment = {}): Promise<ScheduleMechanism> {
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

export function launchAgentPlist(env: Resolved, time: TimeOfDay): string {
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
    // Not at login. A parent who has just turned the computer on wants it responsive, and
    // the run will come round on its own soon enough.
    '  <key>RunAtLoad</key>',
    '  <false/>',
    // Background: launchd may then give it less CPU and less disk priority than whatever
    // the person is actually doing, which is right for an archive job.
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(log)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(log)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function systemdService(env: Resolved): string {
  return [
    '[Unit]',
    'Description=Save new Brightwheel photos to this computer',
    '',
    '[Service]',
    'Type=oneshot',
    // systemd honours double quotes in ExecStart, which is what carries a home directory
    // with a space in it.
    `ExecStart="${env.nodePath}" "${env.cliPath}" ${RUN_ARGS.join(' ')}`,
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

export function cronLine(env: Resolved, time: TimeOfDay): string {
  const log = join(logDir(env), 'daily.log');
  return `${time.minute} ${time.hour} * * * "${env.nodePath}" "${env.cliPath}" ${RUN_ARGS.join(' ')} >> "${log}" 2>&1`;
}

/**
 * The command Task Scheduler stores, as one string.
 *
 * `/TR` takes a whole command line rather than an argument list, so this is the one place a
 * command is assembled as text — by Windows' design, not ours. It is still handed to
 * `execFile` as a single argument, so no shell ever sees it.
 */
export function schtasksCommand(env: Resolved): string {
  return `"${env.nodePath}" "${env.cliPath}" ${RUN_ARGS.join(' ')}`;
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
   * `null` when it could not be asked — a crontab has nothing to ask.
   */
  registered: boolean | null;
  /** The file or entry holding it, so it can be found without this tool. */
  location: string | null;
  /** One or two sentences for the parent, in their words. */
  summary: string;
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
export async function install(timeInput: string, env: ScheduleEnvironment = {}): Promise<ScheduleStatus> {
  const time = parseTimeOfDay(timeInput);
  if (!time) {
    throw new Error(`"${timeInput}" is not a time of day. Give it as HH:MM on a 24-hour clock, for example 19:00.`);
  }
  const e = resolveEnv(env);
  const mechanism = await chooseMechanism(env);
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
      const existing = await e.run('crontab', ['-l']);
      // An empty crontab exits non-zero with "no crontab for <user>" on most systems, which
      // is not a failure — it is the ordinary state of a machine nobody has scheduled
      // anything on. Only the lines we get back matter.
      const kept = stripCronBlock(existing.code === 0 ? existing.stdout : '');
      const written = `${[...kept, CRON_MARKER, cronLine(e, time)].join('\n')}\n`;
      const applied = await e.run('crontab', ['-'], written);
      if (applied.code !== 0) {
        throw new Error(`The daily run could not be added to your crontab: ${applied.stderr.trim() || `crontab exited with ${applied.code}`}.`);
      }
      break;
    }
    case 'schtasks': {
      location = `Task Scheduler, under "${SCHTASKS_NAME}"`;
      // /F overwrites a task of the same name, which is what makes this idempotent.
      const created = await e.run('schtasks', [
        '/Create',
        '/TN',
        SCHTASKS_NAME,
        '/TR',
        schtasksCommand(e),
        '/SC',
        'DAILY',
        '/ST',
        formatTimeOfDay(time),
        '/F',
      ]);
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
    fragilePath: EPHEMERAL.test(e.nodePath) ? e.nodePath : EPHEMERAL.test(e.cliPath) ? e.cliPath : null,
  };
  const config = await loadConfig();
  await saveConfig({ ...config, schedule: record });
  return status(env);
}

/**
 * Take the daily run away. Idempotent: removing one that is not there is not an error, and
 * says so plainly rather than reporting a failure a parent would have to interpret.
 */
export async function remove(env: ScheduleEnvironment = {}): Promise<ScheduleStatus> {
  const e = resolveEnv(env);
  const config = await loadConfig();
  // Whatever installed it is what has to remove it — a machine that has since gained
  // systemd must still be able to clear the crontab line left by the version that had not.
  const mechanism = config.schedule?.mechanism ?? (await chooseMechanism(env));

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
      const existing = await e.run('crontab', ['-l']);
      const kept = stripCronBlock(existing.code === 0 ? existing.stdout : '');
      // Their own lines go back exactly as they were; only ours are gone.
      await e.run('crontab', ['-'], kept.length > 0 ? `${kept.join('\n')}\n` : '');
      break;
    }
    case 'schtasks':
      await e.run('schtasks', ['/Delete', '/TN', SCHTASKS_NAME, '/F']);
      break;
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
  const lastAt = lastRun ? Date.parse(lastRun.at) : NaN;
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

/** Whether the platform's scheduler itself still knows the job. `null` when unanswerable. */
async function isRegistered(e: Resolved, mechanism: ScheduleMechanism): Promise<boolean | null> {
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
 * A crontab with our block taken out.
 *
 * The block is the marker line and the one after it. Trailing blank lines go too, so that
 * installing and removing repeatedly does not grow the file a line at a time.
 */
function stripCronBlock(crontab: string): string[] {
  const lines = crontab.split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.trim() === CRON_MARKER) {
      i += 1; // and the command line that belongs to it
      continue;
    }
    kept.push(lines[i] ?? '');
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
