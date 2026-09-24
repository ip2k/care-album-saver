import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import path from 'node:path';

/**
 * The operating system's own folder chooser, and its file manager.
 *
 * WHY THIS IS SERVER-SIDE AT ALL. A parent should not have to type
 * `/Users/alex/Pictures/Brightwheel` from memory. But a browser will not give a page an
 * absolute path: `<input webkitdirectory>` reports only the folder's own name, and
 * `showDirectoryPicker()` hands back a handle with no path in it. Both withhold it on
 * purpose, because a page knowing where things are on your disk is how fingerprinting and
 * targeted attacks start. So the only thing here that can open a real chooser *and* learn
 * the path it returns is this process, which is already running on the parent's own
 * computer — hence an endpoint rather than a browser API.
 *
 * WHY THAT DESERVES CARE. This turns "a local web page" into "a local web page that can
 * make a process start". Everything below is written on the assumption that a hostile page
 * will one day be pointed at it:
 *
 *  - Nothing is ever passed to a shell. Every call is execFile with the program and an
 *    ARGUMENT ARRAY, so a folder named `; rm -rf ~` is one argument containing semicolons,
 *    not two commands. There is no `exec`, no `shell: true` and no string concatenation of
 *    a path into a command anywhere in this file, and the test suite asserts that.
 *  - Nothing the caller supplies is interpolated into a *script* either. The macOS chooser
 *    is AppleScript and the Windows one is PowerShell; both are fixed literals. That is why
 *    neither is given a "start in this folder" argument, tempting as it is: doing so on
 *    macOS would mean pasting a path into AppleScript source, which is the same class of
 *    injection as a shell string wearing a different hat. A consistent chooser that always
 *    opens where the OS last left it is worth more than that risk.
 *  - openFolder refuses anything that is not an absolute path. That is not tidiness: argv
 *    has no quoting, so a "path" of `-R` would reach `open` as a *flag*. Requiring an
 *    absolute path means the first character is `/` or a drive letter and can never be `-`.
 *  - The caller decides the path for openFolder, and its one caller — the setup server —
 *    reads it from saved settings, never from the request body.
 */

/** What a finished program left behind. */
export interface SpawnResult {
  /** Exit code. Meaningless when `missing` is set. */
  code: number;
  stdout: string;
  stderr: string;
  /** The program is not installed here, so the next candidate should be tried instead. */
  missing?: boolean;
}

/**
 * How a program is run: a file and an argument ARRAY, never a command line.
 *
 * It is a parameter so the tests can stand in for it. No test can click a real dialog, and
 * a suite that shelled out to `osascript` would open windows on the machine running it.
 */
export type SpawnCommand = (file: string, args: readonly string[], timeoutMs: number) => Promise<SpawnResult>;

export interface NativeOptions {
  /** Judge by another operating system's rules. Test-only, as in safety.ts. */
  platform?: NodeJS.Platform;
  /** Stand in for the real `execFile`. Test-only; nothing in the product passes it. */
  spawn?: SpawnCommand;
}

/**
 * How long a chooser may stay open. Generous, because a parent may well go and make a
 * folder while it is up — but not unbounded, so a dialog opened and forgotten does not
 * leave a process waiting for the rest of the session.
 */
const CHOOSER_TIMEOUT_MS = 10 * 60 * 1000;

/** A file manager either appears or does not; it never waits for an answer. */
const OPEN_TIMEOUT_MS = 20 * 1000;

/** The real `execFile`, as a SpawnCommand. Shared with photos.ts and scripts/demo.js, which need the same guarantees. */
export const runProgram: SpawnCommand = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        if (err && err.code === 'ENOENT') {
          resolve({ code: -1, stdout: '', stderr: '', missing: true });
          return;
        }
        if (err?.killed) {
          // The timeout fired. Not a refusal and not a crash, so it gets its own words
          // rather than being reported as either. Any caller can hit it — the folder
          // chooser, opening a folder, Photos — so the words name none of them.
          resolve({ code: 124, stdout: '', stderr: 'It did not finish in time, so it was stopped.' });
          return;
        }
        resolve({
          code: typeof err?.code === 'number' ? err.code : err ? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });

/**
 * The Windows chooser, as a fixed script. Nothing is ever substituted into it.
 *
 * FolderBrowserDialog is the familiar one and needs a single-threaded apartment, which is
 * why the process is started with -STA. A Windows install without the WinForms assembly
 * (Server Core, some trimmed images) throws on Add-Type, so the COM shell chooser is the
 * fallback in the same script — one process, either way.
 */
const WINDOWS_CHOOSER = String.raw`$ErrorActionPreference = 'Stop'
$title = 'Choose where to save your photos'
try {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = $title
  $dialog.ShowNewFolderButton = $true
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }
} catch {
  $shell = New-Object -ComObject Shell.Application
  $folder = $shell.BrowseForFolder(0, $title, 0)
  if ($folder) { [Console]::Out.Write($folder.Self.Path) }
}`;

interface Chooser {
  file: string;
  args: readonly string[];
  /** Exit codes this program uses for "the person pressed Cancel". */
  cancelCodes: readonly number[];
}

/** Anything a chooser says when it was dismissed rather than when it broke. */
const CANCEL_TEXT = /-128|user cancell?ed/i;

function choosers(platform: NodeJS.Platform): Chooser[] {
  const windows: Chooser[] = ['powershell.exe', 'pwsh.exe'].map((file) => ({
    file,
    // -NoProfile so a customised profile cannot change what the script does; -STA because
    // FolderBrowserDialog requires it.
    args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_CHOOSER],
    cancelCodes: [1],
  }));
  if (platform === 'win32') return windows;
  if (platform === 'darwin') {
    return [
      {
        file: 'osascript',
        // `choose folder` is part of macOS itself, so there is nothing to install and no
        // second candidate to fall back to.
        args: ['-e', 'POSIX path of (choose folder with prompt "Choose where to save your photos")'],
        cancelCodes: [1],
      },
    ];
  }
  // Linux, and anything else with an X or Wayland session. Neither chooser is guaranteed
  // to be installed, which is exactly why the typed field stays.
  return [
    {
      file: 'zenity',
      args: ['--file-selection', '--directory', '--title=Choose where to save your photos'],
      cancelCodes: [1],
    },
    { file: 'kdialog', args: ['--getexistingdirectory', homedir()], cancelCodes: [1] },
  ];
}

export type FolderChoice =
  /** A folder was picked. Absolute, exactly as the operating system spelled it. */
  | { ok: true; path: string }
  /** The person closed the dialog. Not an error: nothing should change. */
  | { ok: false; cancelled: true; error?: undefined }
  /** No chooser here, or it failed. The message is for a parent to read. */
  | { ok: false; cancelled?: false; error: string };

/** The first line of a program's complaint, which is the part worth showing. */
const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? '';

/**
 * Open the operating system's folder chooser and wait for an answer.
 *
 * The returned path is NOT validated here — safety.ts decides where a child's photographs
 * may go, and it must decide it for a picked folder exactly as it does for a typed one.
 * A picker that quietly skipped those refusals would be a way around them.
 */
export async function chooseFolder(options: NativeOptions = {}): Promise<FolderChoice> {
  const platform = options.platform ?? osPlatform();
  const spawn = options.spawn ?? runProgram;

  let failure = '';
  for (const chooser of choosers(platform)) {
    const result = await spawn(chooser.file, chooser.args, CHOOSER_TIMEOUT_MS);
    if (result.missing) continue;

    const picked = result.stdout.trim();
    if (result.code === 0) {
      // Windows prints nothing when the dialog is dismissed, and still exits 0.
      return picked ? { ok: true, path: picked } : { ok: false, cancelled: true };
    }
    // "Cancelled" and "broken" share exit code 1 on every Linux chooser: zenity exits 1
    // whether the person pressed Cancel or it could not reach a display at all. What tells
    // them apart is that a failure complains on stderr and a dismissal says nothing. Reading
    // a bare code as a dismissal told a parent "No folder was chosen" on a machine where the
    // dialog never appeared, and stopped the loop before kdialog was tried.
    if (chooser.cancelCodes.includes(result.code) && !firstLine(result.stderr)) {
      return { ok: false, cancelled: true };
    }
    if (CANCEL_TEXT.test(result.stderr)) {
      return { ok: false, cancelled: true };
    }
    // A chooser that is installed but broken is worth trying past — a desktop with a
    // wedged zenity may still have a working kdialog.
    failure = firstLine(result.stderr) || `${chooser.file} stopped unexpectedly.`;
  }

  if (failure) return { ok: false, error: `The folder chooser could not be opened: ${failure}` };
  return {
    ok: false,
    error:
      platform === 'win32' || platform === 'darwin'
        ? 'This computer did not offer a folder chooser. Type the full path in the box instead.'
        : 'This computer has no folder chooser installed (zenity or kdialog). Type the full path in the box instead.',
  };
}

/** How the file manager is opened, per platform. */
function openers(platform: NodeJS.Platform, dir: string): { file: string; args: string[] }[] {
  if (platform === 'darwin') return [{ file: 'open', args: [dir] }];
  if (platform === 'win32') return [{ file: 'explorer.exe', args: [dir] }];
  return [
    { file: 'xdg-open', args: [dir] },
    { file: 'gio', args: ['open', dir] },
  ];
}

/**
 * Show a folder in the file manager.
 *
 * `dir` is always the archive folder from saved settings. It is never taken from a request,
 * so this cannot become "open anything on this machine" — and the absolute-path check below
 * is the second lock on that door, since argv carries no quoting and a leading `-` would
 * otherwise reach the program as a flag.
 */
export async function openFolder(
  dir: string,
  options: NativeOptions = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const platform = options.platform ?? osPlatform();
  const spawn = options.spawn ?? runProgram;
  const p = platform === 'win32' ? path.win32 : path.posix;

  const target = (dir ?? '').trim();
  if (!target || !p.isAbsolute(target) || target.startsWith('-')) {
    return { ok: false, error: 'There is no folder to open yet. Choose one first.' };
  }
  try {
    if (!(await stat(target)).isDirectory()) {
      return { ok: false, error: 'That is a file, not a folder.' };
    }
  } catch {
    // The archive folder is made by the first run, not by saving the setting, so "not there
    // yet" is the ordinary state before anything has been saved — and saying so is more use
    // than the operating system's own error would be.
    return { ok: false, error: 'That folder does not exist yet. It is created the first time photos are saved.' };
  }

  let failure = '';
  for (const opener of openers(platform, target)) {
    const result = await spawn(opener.file, opener.args, OPEN_TIMEOUT_MS);
    if (result.missing) continue;
    // Windows Explorer exits 1 even when it opened the window, so on Windows the exit code
    // says nothing and is not consulted.
    if (result.code === 0 || platform === 'win32') return { ok: true };
    failure = firstLine(result.stderr) || `${opener.file} stopped unexpectedly.`;
  }

  return {
    ok: false,
    error: failure
      ? `The folder could not be opened: ${failure}`
      : 'This computer has no file manager this tool can open. The folder is on your disk all the same.',
  };
}
