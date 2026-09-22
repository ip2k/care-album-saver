/**
 * ISO 8601 week numbering.
 *
 * The subtlety that bites everyone: the *week-numbering year* is not always the calendar
 * year. 1 January 2027 falls in week 53 of 2026, so its folder is `2026-W53`, not
 * `2027-W53` (which does not exist) and not `2027-W01`. Getting this wrong scatters a
 * single week's photos across two folders every few years, which is exactly the kind of
 * quiet corruption nobody notices until the archive is years deep.
 *
 * ISO 8601 defines: weeks start on Monday, and week 1 is the week containing the first
 * Thursday of the year.
 */

export interface IsoWeek {
  /** ISO week-numbering year. May differ from the calendar year at year boundaries. */
  year: number;
  /** ISO week number, 1-53. */
  week: number;
}

/**
 * Compute the ISO week-numbering year and week for a date, by the *local* clock of the
 * machine this runs on (`getFullYear`, `getMonth`, `getDate` — all local).
 *
 * There is deliberately no timezone argument. A `Date` is an instant; which calendar day
 * that instant belongs to is a question only a timezone can answer, and the source of these
 * instants (Brightwheel's `event_date`) does not say which one the photo was taken in. A
 * zone guessed here — from the machine, from the school's name, from anything — would file
 * a late-afternoon photo under the next day while looking authoritative, which is worse
 * than filing it by a clock the person can see and reason about.
 *
 * So: the archiving machine's clock decides, and the caller is expected to say so in
 * writing where the archive can be read years later. A person who wants a different clock
 * sets `TZ` for the process (`TZ=America/Los_Angeles brightwheel-archive run`), which Node
 * honours everywhere and which needs no setting of our own to get out of step.
 */
export function isoWeek(date: Date): IsoWeek {
  // Work on a UTC copy of the local Y/M/D so arithmetic is DST-proof.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Shift to the Thursday of this week: ISO week N always contains its Thursday,
  // and the Thursday's calendar year is by definition the week-numbering year.
  const dayNum = d.getUTCDay() || 7; // Sunday 0 -> 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const year = d.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return { year, week };
}

/** Folder label for a week, e.g. `2026-W38`. Zero-padded so folders sort correctly. */
export function weekFolder(date: Date): string {
  const { year, week } = isoWeek(date);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The Monday that starts the ISO week containing `date`, at local midnight. */
export function weekStart(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayNum = d.getDay() || 7;
  d.setDate(d.getDate() - (dayNum - 1));
  return d;
}

/** The Sunday that ends the ISO week containing `date`, at local midnight. */
export function weekEnd(date: Date): Date {
  const d = weekStart(date);
  d.setDate(d.getDate() + 6);
  return d;
}

/**
 * A human-friendly description of the week, for a folder README or UI label.
 * e.g. "15-21 September 2026" or "29 September - 5 October 2026".
 */
export function weekLabel(date: Date, locale = 'en-US'): string {
  const s = weekStart(date);
  const e = weekEnd(date);
  const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
  const month = new Intl.DateTimeFormat(locale, { month: 'long' });
  const full = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', year: 'numeric' });
  if (sameMonth) {
    return `${s.getDate()}-${e.getDate()} ${month.format(s)} ${s.getFullYear()}`;
  }
  return `${full.format(s)} - ${full.format(e)}`;
}

/** Local Y/M/D/H/M/S string in EXIF's format: "YYYY:MM:DD HH:MM:SS". */
export function exifDateTime(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}:${p(date.getMonth() + 1)}:${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
  );
}

/** UTC offset in EXIF's OffsetTime format: "+HH:MM" / "-HH:MM". */
export function exifOffset(date: Date): string {
  const mins = -date.getTimezoneOffset();
  const sign = mins >= 0 ? '+' : '-';
  const a = Math.abs(mins);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
