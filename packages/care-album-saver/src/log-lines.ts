import { StringDecoder } from 'node:string_decoder';
/**
 * Every line of the daily log starts with when it was written, in ISO 8601.
 *
 * The log has two writers. `appendLog` adds the tool's own one-line records — START, OK,
 * FAILED, SKIPPED, PHOTOS — and a scheduled run's ordinary output ("Looking for Robin's
 * photos", "Saved 3 new items") reaches the same file because launchd's StandardOutPath and
 * cron's `>>` point it there. The first writer always stamped its lines; the second never
 * did, so most of the log said what happened and not when.
 *
 * The stamp is local time with its offset from UTC — 2026-09-23T17:00:04-07:00 — rather
 * than UTC's Z. Both are ISO 8601 and both sort and parse the same way, but a parent
 * reading why the five o'clock run failed should see 17:00, not 00:00 the next day.
 */

const pad = (n: number, width = 2): string => String(Math.trunc(Math.abs(n))).padStart(width, '0');

/** ISO 8601 to the second, in this computer's time zone, with its UTC offset. */
export function logTimestamp(date: Date = new Date()): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(offset / 60)}:${pad(offset % 60)}`
  );
}

type Write = NodeJS.WritableStream['write'];

/**
 * Make everything written to a stream start each line with a timestamp, from now on.
 *
 * Used for a scheduled run's stdout and stderr, which are the log. Lines are stamped as
 * they begin, so output written a piece at a time is stamped once. Blank lines are dropped:
 * on a terminal they space a summary out, in a log they are entries with nothing in them.
 * Returns a function that puts the stream back.
 */
export function stampLines(stream: NodeJS.WritableStream, now: () => Date = () => new Date()): () => void {
  const original = stream.write;
  let atLineStart = true;
  // One decoder for the stream, not a decode per write: a character whose bytes arrive in two
  // writes, as a pipe may split them, stays one character rather than two U+FFFDs
  // (security review processes-7).
  const decoder = new StringDecoder('utf8');
  // Whitespace that began a line, held until the rest of the line shows whether it is blank.
  let held = '';

  const stamped = function (this: NodeJS.WritableStream, chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    const text = held + (typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk as Uint8Array)));
    held = '';

    let out = '';
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const complete = i < lines.length - 1;
      if (atLineStart) {
        // A whole line with nothing on it: dropped, newline and all.
        if (line.trim() === '' && complete) return;
        // Nothing but whitespace so far, and the line not finished: whether it is blank is
        // decided when the rest of it arrives, not now.
        if (line.trim() === '') {
          held = line;
          return;
        }
        out += `${logTimestamp(now())}  `;
      }
      out += line;
      if (complete) out += '\n';
      atLineStart = complete;
    });
    return original.call(this, out, 'utf8', callback as (error?: Error | null) => void);
  };

  stream.write = stamped as Write;
  return () => {
    stream.write = original;
  };
}
