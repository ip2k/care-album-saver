import { platform as osPlatform } from 'node:os';

/**
 * A size, written the way this computer's own file manager writes it.
 *
 * The number on the page should be the number a parent sees when they check — and the
 * three file managers disagree, both about what a megabyte is and about how to write one:
 *
 *  - Finder (macOS 10.6 and later) counts 1 MB as 1,000,000 bytes, through Apple's own byte
 *    formatter: whole kilobytes, one decimal for megabytes, two for gigabytes, and no
 *    trailing zeros — 12 KB, 228.1 MB, 1.23 GB, 1 GB.
 *  - GNOME Files, Ubuntu's file manager, also counts 1,000,000 bytes, through GLib's
 *    g_format_size: always one decimal, and a lowercase k — 12.3 kB, 228.1 MB, 1.0 GB.
 *  - Windows Explorer counts 1 MB as 1,048,576 bytes and still calls it MB, through
 *    StrFormatByteSize: three significant figures, cut rather than rounded — 12.0 KB,
 *    217 MB, 1.20 GB.
 *
 * Before this, the dashboard divided by 1,048,576 and wrote "MB" on every platform while the
 * folder check divided by 1,000,000, so one archive was 218 MB on one screen and 231 MB on
 * the next, and Finder agreed with neither of the dashboard's figures.
 */
export function formatBytes(bytes: number, platform: NodeJS.Platform = osPlatform()): string {
  const n = Math.max(0, Math.floor(bytes));
  if (platform === 'win32') return explorer(n);
  if (platform === 'darwin') return finder(n);
  return gnome(n);
}

const plural = (n: number): string => `${n} byte${n === 1 ? '' : 's'}`;

function finder(n: number): string {
  if (n < 1000) return plural(n);
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  const decimals = [0, 1, 2, 2, 2];
  let value = n / 1000;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i += 1;
  }
  let shown = Number(value.toFixed(decimals[i]));
  // Rounding can carry into the next unit: 999,960 bytes is 1 MB, not 1,000 KB.
  if (shown >= 1000 && i < units.length - 1) {
    value /= 1000;
    i += 1;
    shown = Number(value.toFixed(decimals[i]));
  }
  // Number() drops the trailing zeros Apple's formatter drops: 1.20 GB is written 1.2 GB.
  return `${shown} ${units[i]}`;
}

function gnome(n: number): string {
  if (n < 1000) return plural(n);
  // GLib picks the unit from the byte count itself, not from the rounded figure, so 999,999
  // bytes really is "1000.0 kB" in Files. Matching the file manager means matching that.
  const units: [number, string][] = [
    [1e18, 'EB'], [1e15, 'PB'], [1e12, 'TB'], [1e9, 'GB'], [1e6, 'MB'], [1e3, 'kB'],
  ];
  const [factor, unit] = units.find(([f]) => n >= f)!;
  return `${(n / factor).toFixed(1)} ${unit}`;
}

function explorer(n: number): string {
  if (n < 1024) return plural(n);
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  // Three significant figures, truncated — 217.55 is 217, 1.2059 is 1.20.
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const factor = 10 ** decimals;
  return `${(Math.floor(value * factor) / factor).toFixed(decimals)} ${units[i]}`;
}
