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

  const stamped = function (this: NodeJS.WritableStream, chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    const text =
      typeof chunk === 'string'
        ? chunk
        : Buffer.from(chunk as Uint8Array).toString(typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');

    let out = '';
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const complete = i < lines.length - 1;
      if (atLineStart) {
        // A whole line with nothing on it: dropped, newline and all.
        if (line.trim() === '' && complete) return;
        if (line === '') return;
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
