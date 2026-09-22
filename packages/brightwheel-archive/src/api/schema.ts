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

export class ApiShapeError extends Error {
  constructor(message: string, public readonly context?: string) {
    super(message);
    this.name = 'ApiShapeError';
  }
}

export class SessionExpiredError extends Error {
  constructor(message = 'Your Brightwheel session has expired. Run `brightwheel-archive login` to sign in again.') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/**
 * Assert that a response really is JSON from the API, not a login page or an error page.
 * Called before any parsing.
 */
export function assertJsonResponse(response: Response, body: string, context: string): void {
  if (response.status === 401 || response.status === 403) {
    throw new SessionExpiredError();
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    // The single most common cause is an expired session redirecting to the sign-in page.
    const looksLikeLogin = /<html|sign\s*in|log\s*in|password/i.test(body.slice(0, 2000));
    if (looksLikeLogin) throw new SessionExpiredError();
    throw new ApiShapeError(
      `Expected JSON from ${context} but got "${contentType || 'no content-type'}". ` +
        `This usually means Brightwheel changed something, or you are being asked to sign in again.`,
      context,
    );
  }
  if (!response.ok) {
    throw new ApiShapeError(`HTTP ${response.status} from ${context}`, context);
  }
}

function req(obj: Record<string, unknown>, key: string, context: string): unknown {
  if (!(key in obj) || obj[key] === null || obj[key] === undefined) {
    throw new ApiShapeError(
      `Brightwheel's response for ${context} is missing the "${key}" field. ` +
        `The API may have changed; please open an issue with the output of ` +
        `\`brightwheel-archive doctor\`.`,
      context,
    );
  }
  return obj[key];
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiShapeError(`Expected an object for ${context}, got ${typeof value}`, context);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ApiShapeError(`Expected a list for ${context}, got ${typeof value}`, context);
  }
  return value;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export interface Student {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  schoolName: string | null;
}

export interface MediaActivity {
  /** Brightwheel's own id for this post. The primary deduplication key. */
  id: string;
  studentId: string | null;
  /** The moment the photo was taken, as reported by Brightwheel. */
  capturedAt: Date;
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
  // Observed shapes differ: some deployments nest under "object", some do not.
  const user = 'object' in o ? asObject(o.object, 'users/me.object') : o;
  return {
    id: String(req(user, 'id', 'users/me')),
    email: str(user.email),
  };
}

/** `GET /api/v1/guardians/{id}/students` */
export function parseStudents(raw: unknown): Student[] {
  const o = asObject(raw, 'students');
  const list = asArray(o.students ?? o.data ?? o.object ?? [], 'students list');
  return list.map((entry, i) => {
    const wrapper = asObject(entry, `students[${i}]`);
    // Observed: each entry may be {student: {...}} or the student object directly.
    const s = 'student' in wrapper ? asObject(wrapper.student, `students[${i}].student`) : wrapper;
    const first = str(s.first_name) ?? '';
    const last = str(s.last_name) ?? '';
    const school = s.school ? asObject(s.school, `students[${i}].school`) : null;
    return {
      id: String(req(s, 'id', `students[${i}]`)),
      firstName: first,
      lastName: last,
      fullName: [first, last].filter(Boolean).join(' ') || `Student ${i + 1}`,
      schoolName: school ? str(school.name) : null,
    };
  });
}

/**
 * Pick the capture time from an activity.
 *
 * Order matters and is deliberate: `event_date` is when the photo was *taken*, while
 * `created_at` is when it was *uploaded*. A teacher photographing at 9am and uploading at
 * 5pm would otherwise land every morning photo in the evening — and, at week boundaries,
 * in the wrong week folder entirely. Preferring event_date is the whole reason this tool
 * writes corrected timestamps instead of trusting the download.
 */
function pickCaptureTime(a: Record<string, unknown>, context: string): Date {
  for (const key of ['event_date', 'event_time', 'created_at', 'updated_at']) {
    const v = a[key];
    if (typeof v === 'string') {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  throw new ApiShapeError(`No usable timestamp on ${context}`, context);
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|avif)(\?|$)/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|avi)(\?|$)/i;

/** `GET /api/v1/students/{id}/activities` — returns only the entries that carry media. */
export function parseActivities(raw: unknown, studentId: string): MediaActivity[] {
  const o = asObject(raw, 'activities');
  const list = asArray(o.activities ?? o.data ?? o.object ?? [], 'activities list');
  const out: MediaActivity[] = [];

  for (let i = 0; i < list.length; i++) {
    const a = asObject(list[i], `activities[${i}]`);
    const media =
      str(a.media_url) ??
      str(a.image_url) ??
      str(a.video_url) ??
      (a.media ? str(asObject(a.media, `activities[${i}].media`).url) : null);
    if (!media) continue; // Check-ins, naps and meals carry no media. Skip silently.

    const isVideo = VIDEO_EXT.test(media) || a.action_type === 'ac_video' || Boolean(a.video_url);
    if (!isVideo && !IMAGE_EXT.test(media) && !a.media_url && !a.image_url) continue;

    out.push({
      id: String(req(a, 'id', `activities[${i}]`)),
      studentId,
      capturedAt: pickCaptureTime(a, `activities[${i}]`),
      note: str(a.note) ?? str(a.description) ?? null,
      url: media,
      kind: isVideo ? 'video' : 'image',
      author: a.actor ? str(asObject(a.actor, `activities[${i}].actor`).name) : null,
    });
  }
  return out;
}

/**
 * The extraction gate.
 *
 * Adapted from the house scraping rules: never hand downstream code an extraction result
 * without checking it first. An empty page is legitimate (it is how pagination ends), but
 * an empty *first* page for an account that should have photos is a signal, not a result.
 */
export interface ExtractionCheck {
  status: 'ok' | 'empty' | 'suspicious';
  message: string;
  count: number;
}

export function validateExtraction(items: MediaActivity[], page: number): ExtractionCheck {
  if (items.length > 0) {
    const bad = items.filter((i) => Number.isNaN(i.capturedAt.getTime()));
    if (bad.length > 0) {
      return {
        status: 'suspicious',
        message: `${bad.length} of ${items.length} items had an unreadable timestamp`,
        count: items.length,
      };
    }
    return { status: 'ok', message: `${items.length} media items on page ${page}`, count: items.length };
  }
  return {
    status: 'empty',
    message: page === 0 ? 'No media found at all' : `End of results at page ${page}`,
    count: 0,
  };
}
