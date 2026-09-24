/**
 * Validation gate for everything the Brightwheel API returns.
 *
 * Brightwheel publishes no API specification, so every field name here is an observed
 * shape, not a contract. That has two consequences this module exists to handle:
 *
 *  1. The shape can change without warning. We validate rather than trust, and fail with
 *     a message that says exactly which field was missing — so a future breakage is a
 *     five-minute fix rather than an archaeology project.
 *
 *  2. The classic session-expiry trap: an expired session does not reliably produce a 401.
 *     It often produces HTTP 200 with an HTML login page. Parsed loosely, that yields zero
 *     activities, and an unattended nightly run would cheerfully report "0 new photos" for
 *     months. Asserting the content type *and* the JSON shape turns that silent failure
 *     into a loud one.
 *
 * Hand-written rather than using a schema library, to keep the runtime dependency count
 * at zero.
 */

import { createHash } from 'node:crypto';
import { mediaUrlRefusal, transferIdentity } from '../ferry/url.js';

export class ApiShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiShapeError';
  }
}

export class SessionExpiredError extends Error {
  constructor(message = 'Your Brightwheel session has expired. Run `care-album-saver login` to sign in again.') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/**
 * Assert that a response really is JSON from the API, not a login page or an error page.
 * Called before any parsing.
 *
 * The "that is a sign-in page" guess is made only of a successful answer. It used to be
 * made of any answer that was not JSON, before the status was looked at, so an HTML error
 * page — a 404 or a 502 from something in between, a proxy asking for its own password —
 * mentioning "log in" anywhere told the parent their session had expired and sent them off
 * to copy it again, which could not help. An expired session that Brightwheel answers with
 * its sign-in page answers 200 (or 401/403, which are read as expiry whatever the body);
 * any other status is reported as the status it is, with what the body said it was
 * (the outbound verifier's "sign-in heuristic").
 */
export function assertJsonResponse(response: Response, body: string, context: string): void {
  if (response.status === 401 || response.status === 403) {
    throw new SessionExpiredError();
  }
  const contentType = response.headers.get('content-type') ?? '';
  const shown = describeContentType(contentType);
  if (!response.ok) {
    throw new ApiShapeError(`HTTP ${response.status} from ${context} (${shown})`);
  }
  if (!contentType.includes('json')) {
    // The single most common cause is an expired session redirecting to the sign-in page.
    const looksLikeLogin = /<html|sign\s*in|log\s*in|password/i.test(body.slice(0, 2000));
    if (looksLikeLogin) throw new SessionExpiredError();
    throw new ApiShapeError(
      `Expected JSON from ${context} but got "${shown}". ` +
        `This usually means Brightwheel changed something, or you are being asked to sign in again.`,
    );
  }
}

/**
 * A response's content type as a message may quote it: the header is the server's to fill,
 * so it is cut short and kept to printable characters before it goes anywhere a parent reads.
 */
export function describeContentType(contentType: string | null): string {
  const shown = (contentType ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 80);
  return shown || 'no content-type';
}

/** The refusal for a field that is not there, worded for whoever has to fix it. */
function missing(key: string, context: string): ApiShapeError {
  return new ApiShapeError(
    `Brightwheel's response for ${context} is missing the "${key}" field. ` +
      `The API may have changed; please open an issue with the output of ` +
      `\`care-album-saver doctor\`.`,
  );
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiShapeError(`Expected an object for ${context}, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ApiShapeError(`Expected a list for ${context}, got ${typeof value}`);
  }
  return value;
}

/**
 * C0 control characters but tab, line feed and carriage return; DEL; and the C1 block. None
 * belongs in a name or a note, and each does something to whatever prints it: an escape
 * sequence repaints a terminal, a NUL makes ExifTool refuse the whole write (fs-12), a
 * backspace rewrites the log line it is in.
 */
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * The one reader for every string from Brightwheel that a person will read — a child's and
 * a teacher's name, the school, the account's address, a note — so that every printer of
 * them (the terminal, the daily log, the setup page, the sidecar, the tags inside a photo)
 * gets text that is already clean (security review processes-8, whose finding was child
 * names that kept their control characters). Composed to NFC, so one name is one sequence
 * of code points whichever keyboard typed it; the control characters above removed.
 *
 * `multiline` is for a note, whose line breaks and tabs are part of what the teacher wrote.
 * Everywhere else a line break or tab becomes a space: a name that could end a log line
 * could also forge the next one.
 *
 * Null when nothing is left, as for a string that was empty to begin with.
 */
function text(v: unknown, multiline = false): string | null {
  if (typeof v !== 'string') return null;
  // Removed, not replaced (§4.6, F18, decided): a space would show as "Ro b in", and a name of
  // controls alone would stop being no name. The cost is that a name which carried one gets a
  // new folder, "Robin-Maple" where safeStem once made "Ro-bin-Maple"; nothing is downloaded
  // again, because the list knows each post by its id, not by its folder.
  let clean = v.normalize('NFC').replace(CONTROLS, '');
  if (!multiline) clean = clean.replace(/[\t\n\r]/g, ' ');
  return clean.length > 0 ? clean : null;
}

/**
 * A media address, read exactly as sent. Not `text()`: a signed URL is a credential whose
 * every byte is checked by the CDN, so it is never rewritten, only vetted — see
 * `mediaUrlRefusal`, and redactUrl in ferry/download.ts for how one is ever shown.
 */
const address = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * The first of these that can serve as an id, exactly as it has always been written down —
 * `String()` of it — or null when none can.
 *
 * An id is a key: the manifest de-duplicates on a post's, the cut-off is kept per child's.
 * `String()` of anything at all used to be accepted, so an empty `object_id` gave every post
 * the id "" and the first one saved stood for all of them — the rest were skipped as already
 * had (security review outbound-4). `{}` and `true` did the same through "[object Object]"
 * and "true". So only a string with something in it, or a finite number, is an id; and an
 * unusable `object_id` no longer hides a good `id` beside it. Every id that was usable before
 * comes out character for character as it did, so no existing archive fetches anything again.
 */
function usableId(...candidates: unknown[]): string | null {
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/**
 * An id for a post that carries none, made from what it is a post OF: its media's address
 * with the signature taken off (`transferIdentity`), hashed.
 *
 * Stable where it matters: the signature changes on every listing and the address under it
 * does not, so the same photo gets the same id on every run, and a page listed again for a
 * fresh signature finds it under the same id. Two posts of one file are one photo, which is
 * the answer the manifest's second key gives too; two posts of different files are two. The
 * prefix keeps these apart from Brightwheel's own ids, which are never shaped like this.
 */
function idFromMedia(url: string): string {
  return `media-${createHash('sha256').update(transferIdentity(url)).digest('hex').slice(0, 32)}`;
}

export interface Student {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  schoolName: string | null;
}

export interface MediaActivity {
  /**
   * Brightwheel's own id for this post — or, for a post that carries none it can use, one
   * made from its media (`idFromMedia`). The primary deduplication key.
   */
  id: string;
  studentId: string | null;
  /**
   * When Brightwheel says the post was made (event_date, else created_at); not when the
   * photo was taken, which the API does not carry.
   */
  postedAt: Date;
  /** Note or caption written by the teacher, if any. */
  note: string | null;
  /** Full-size media URL. Usually signed and short-lived. */
  url: string;
  kind: 'image' | 'video';
  /** Who posted it, when Brightwheel says. */
  author: string | null;
}

/** `GET /api/v1/users/me` */
export function parseMe(raw: unknown): { id: string; email: string | null } {
  const o = asObject(raw, 'users/me');
  // Observed shapes differ: some responses nest under "object", some do not.
  const user = 'object' in o ? asObject(o.object, 'users/me.object') : o;
  // Brightwheel names its primary keys `object_id` throughout, not `id`. Confirmed against
  // sanitized fixtures in stephenyeargin/hubot-brightwheel and roloenusa/brightwheel_downloader.
  // An empty one is as good as none: it would ask for the children of `/guardians//`.
  const id = usableId(user.object_id, user.id);
  if (id === null) {
    throw new ApiShapeError(
      'Brightwheel did not return an account id (expected "object_id"). The API may have changed.',
    );
  }
  return { id, email: text(user.email) };
}

/** `GET /api/v1/guardians/{id}/students` */
export function parseStudents(raw: unknown): Student[] {
  const o = asObject(raw, 'students');
  const list = asArray(o.students ?? o.data ?? o.object ?? [], 'students list');
  return list.map((entry, i) => {
    const wrapper = asObject(entry, `students[${i}]`);
    // Observed: each entry may be {student: {...}} or the student object directly.
    const s = 'student' in wrapper ? asObject(wrapper.student, `students[${i}].student`) : wrapper;
    const first = text(s.first_name) ?? '';
    const last = text(s.last_name) ?? '';
    const school = s.school ? asObject(s.school, `students[${i}].school`) : null;
    // A child's id keys their cut-off and their place in the selection of children, so two
    // children with an empty one would share both. There is nothing to derive one from, so
    // an unusable id is refused as a missing one always was.
    const id = usableId(s.object_id, s.id);
    if (id === null) throw missing('id', `students[${i}]`);
    return {
      id,
      firstName: first,
      lastName: last,
      fullName: [first, last].filter(Boolean).join(' ') || `Student ${i + 1}`,
      schoolName: school ? text(school.name) : null,
    };
  });
}

/**
 * Pick the best date an activity carries.
 *
 * This function used to be the heart of the project's claim: that `event_date` is when the
 * photo was TAKEN and `created_at` when it was UPLOADED, so preferring the first recovered
 * a capture time the website's own download loses. Checked against the live service on
 * 2026-09-22, that is not so:
 *
 *   - `event_date` and `created_at` were identical on all 50 records sampled, and no other
 *     field on the record carries a time (`verify` lists every field name, so this can be
 *     re-checked rather than believed).
 *   - The photographs themselves arrive with no EXIF at all — no DateTimeOriginal, no GPS.
 *     Brightwheel strips it, or the posting app never wrote it. `verify --deep` checks.
 *
 * So the moment a photo was taken is not recoverable from Brightwheel, by this tool or by
 * anything else reading the same API. What IS recoverable is when it was posted, which for
 * a nursery is usually minutes later and nearly always the same day — and which is still a
 * great deal better than the download time a browser gives the file.
 *
 * The order below is therefore kept, but for a smaller reason: if some other nursery's
 * records do distinguish the two, `event_date` remains the likelier capture time, and
 * preferring it costs nothing where they are equal. It is no longer load-bearing.
 *
 * Returns null rather than throwing when none of those fields holds a date we can read.
 * One entry must not decide the fate of the page by itself: the count of undated entries
 * is what `validateExtraction` weighs, and that gate is where the refusal belongs.
 */
function pickPostedTime(a: Record<string, unknown>): Date | null {
  for (const key of ['event_date', 'event_time', 'created_at', 'updated_at']) {
    const v = a[key];
    if (typeof v === 'string') {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

/**
 * Who posted the photo.
 *
 * `actor.name` does not exist. It came from another project's fixtures, and because nothing
 * had ever run against the real service, every archive this tool wrote recorded no author
 * at all. Verified live on 2026-09-22: the real record carries `actor.first_name`,
 * `actor.last_name`, `actor.object_id`, `actor.email` and `actor.role`.
 *
 * `name` is still read first, so a future API that grows one is handled, and a mock or
 * fixture written against the old shape keeps working.
 *
 * The email is deliberately NOT read. It belongs to a member of staff who never agreed to
 * be in a parent's photo archive, and a name is all the provenance an archive needs.
 */
function pickAuthor(actor: unknown, context: string): string | null {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return null;
  const o = asObject(actor, context);
  const whole = text(o.name);
  if (whole) return whole;
  const parts = [text(o.first_name), text(o.last_name)].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|avi)(\?|$)/i;

/** What one page of the feed yielded, and what it could not. */
export interface ParsedActivities {
  /** The media posts this tool can file: they carry media and a readable posted time. */
  items: MediaActivity[];
  /**
   * How many entries carried media but no date this tool could read. Kept rather than
   * thrown away because it is the signal that Brightwheel has renamed its date field, and
   * a page of undated photos is indistinguishable from a page of no photos without it.
   */
  undated: number;
  /**
   * How many entries carried media at an address this tool will not fetch from
   * (`mediaUrlRefusal`: not https, or this computer or the local network). Counted for the
   * same reason as `undated`: dropped quietly, they would be photos missing from the archive
   * with nothing said.
   */
  refused: number;
  /** Why the first of those was refused, in words; null when none was. */
  refusedBecause: string | null;
}

export interface ParseActivitiesOptions {
  /**
   * The one origin a media address may have without being https and public: the API's own,
   * when that is this computer — the mock server, the demo and the tests. The client sets
   * it (see `loopbackOrigin` in ferry/url.ts); nothing else should.
   */
  trustedMediaOrigin?: string | null;
}

/** `GET /api/v1/students/{id}/activities` — returns only the entries that carry media. */
export function parseActivities(raw: unknown, studentId: string, options: ParseActivitiesOptions = {}): ParsedActivities {
  const o = asObject(raw, 'activities');
  const list = asArray(o.activities ?? o.data ?? o.object ?? [], 'activities list');
  const out: MediaActivity[] = [];
  let undated = 0;
  let refused = 0;
  let refusedBecause: string | null = null;

  for (let i = 0; i < list.length; i++) {
    const a = asObject(list[i], `activities[${i}]`);
    // The real shapes, from sanitized fixtures: a photo carries `media.image_url`, while a
    // video carries `video_info.downloadable_url` AND has `media: null`. The flat
    // `media_url` / `image_url` fallbacks below are kept for older or partial responses.
    const mediaObj = a.media && typeof a.media === 'object' ? (a.media as Record<string, unknown>) : null;
    const videoObj =
      a.video_info && typeof a.video_info === 'object' ? (a.video_info as Record<string, unknown>) : null;

    const videoUrl = videoObj ? address(videoObj.downloadable_url) ?? address(videoObj.url) : address(a.video_url);
    const imageUrl = mediaObj
      ? address(mediaObj.image_url) ?? address(mediaObj.url)
      : address(a.media_url) ?? address(a.image_url);

    const media = videoUrl ?? imageUrl;
    if (!media) continue; // Check-ins, naps, meals and notes carry no media. Skip silently.

    // Before anything else is made of it: an address the tool will not fetch from is not an
    // item, and it is counted rather than dropped. See ParsedActivities.refused.
    const refusal = mediaUrlRefusal(media, options.trustedMediaOrigin);
    if (refusal) {
      refused += 1;
      refusedBecause ??= refusal;
      continue;
    }

    const isVideo = Boolean(videoUrl) || a.action_type === 'ac_video' || VIDEO_EXT.test(media);

    const postedAt = pickPostedTime(a);
    if (!postedAt) {
      // A photo we cannot date is a photo we cannot file, and filing by date is the point
      // of this tool. So it is counted, not quietly dropped and not stamped with a guess;
      // `validateExtraction` decides what the count means.
      undated += 1;
      continue;
    }

    out.push({
      // Derived rather than refused when there is no id: one post Brightwheel sent without
      // one must not stop the page, and with it every older photo, on every run.
      id: usableId(a.object_id, a.id) ?? idFromMedia(media),
      studentId,
      postedAt,
      note: text(a.note, true) ?? text(a.description, true) ?? null,
      url: media,
      kind: isVideo ? 'video' : 'image',
      author: pickAuthor(a.actor, `activities[${i}].actor`),
    });
  }
  return { items: out, undated, refused, refusedBecause };
}

/**
 * The extraction gate.
 *
 * Adapted from the house scraping rules: never hand downstream code an extraction result
 * without checking it first. An empty page is legitimate (it is how pagination ends), but
 * an empty *first* page for an account that should have photos is a signal, not a result.
 *
 * `suspicious` is the one that earns this function its place. It fires when a page carried
 * photos or videos that could not be dated — the shape of the failure Brightwheel renaming
 * `event_date` would produce. Without the `undated` count those posts look exactly like no
 * posts at all, and the caller would report "no new photos" every night for ever.
 *
 * A photo at an address the tool will not fetch from (`refused`) is weighed the same way and
 * for the same reason: skipping it would leave a hole in the archive that nothing mentions.
 * The run stops and says why, and the next one asks again.
 */
export interface ExtractionCheck {
  status: 'ok' | 'empty' | 'suspicious';
  message: string;
}

export function validateExtraction(
  items: MediaActivity[],
  page: number,
  undated = 0,
  refused = 0,
  refusedBecause: string | null = null,
): ExtractionCheck {
  // Weighed first, and deliberately before the empty case: a page where every post was
  // undated or refused has no items, and reading that as "the feed has ended" is the silent
  // failure.
  const posts = (n: number) => `${n} post${n === 1 ? '' : 's'} on page ${page}`;
  const reasons: string[] = [];
  if (undated > 0) {
    reasons.push(
      `${posts(undated)} carried a photo or video with ` +
        `no date this tool could read. Brightwheel may have renamed the date field; filing them by ` +
        `guesswork would put them in the wrong week, so the run stops instead.`,
    );
  }
  if (refused > 0) {
    reasons.push(
      `${posts(refused)} carried a photo or video at an address this tool does not fetch from` +
        `${refusedBecause ? `, because ${refusedBecause}` : ''}. Brightwheel's photos come from a public ` +
        `https address, and fetching this one could reach something on your own network instead, so ` +
        `the run stops here rather than leave them out without a word. The next run will ask again.`,
    );
  }
  if (reasons.length > 0) return { status: 'suspicious', message: reasons.join(' ') };
  if (items.length > 0) {
    return { status: 'ok', message: `${items.length} media items on page ${page}` };
  }
  return {
    status: 'empty',
    message: page === 0 ? 'No media found at all' : `End of results at page ${page}`,
  };
}
