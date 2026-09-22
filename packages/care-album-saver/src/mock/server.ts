import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { placeholderJpeg, placeholderMp4 } from './fixtures.js';

/**
 * A stand-in Brightwheel server with entirely invented children.
 *
 * This exists for two reasons, and the second one is not negotiable:
 *
 *  1. The tests need a deterministic API to run against, including the failure modes that
 *     matter — an expired session returning an HTML login page with HTTP 200, a signed URL
 *     whose signature changes on every request, and pagination that ends.
 *
 *  2. The documentation screenshots must never contain a real child. Every face, name and
 *     note in this file is synthetic, so the screenshots in `docs/` can be committed to a
 *     public repository without exposing anybody's family.
 *
 * The photos and videos are real, tiny JPEG and MP4 files generated in `fixtures.ts`, each
 * a solid colour derived from the activity id, so the same fake photo always looks the
 * same and ExifTool can genuinely write into it — which is what lets the tests prove the
 * embedded dates and names are right, rather than assuming.
 */

export interface MockOptions {
  /** Session value that counts as valid. Anything else gets the login page. */
  validSession?: string;
  /** Number of media activities to generate per student. */
  activitiesPerStudent?: number;
  /** Simulate an expired session for every request. */
  forceExpired?: boolean;
  /**
   * The session stops working after this many API requests have been served with it.
   * Deterministic stand-in for a session that expires part-way through a long run.
   */
  expireSessionAfterRequests?: number;
  /**
   * A signed media URL works for this many further requests (of any kind) after the
   * listing that issued it, then the CDN answers 403. Models signatures that a long run
   * outlives, without depending on the clock.
   */
  mediaUrlExpiresAfterRequests?: number;
  /** Refuse a media URL whose `expires=` has passed, as the real CDN does. */
  enforceMediaUrlExpiry?: boolean;
  /**
   * Clamp `page_size`, as a real API may. Lets a test walk several pages with a handful
   * of items, and proves the client reads the envelope rather than trusting what it asked for.
   */
  maxPageSize?: number;
  /**
   * Posts without media — check-ins — at the top of the feed. With a small `maxPageSize`
   * this makes a whole page that carries no photos, which is not the end of the feed.
   */
  leadingCheckIns?: number;
  /**
   * Photos at the very top of the feed whose capture times are two months OLDER than every
   * other post: a teacher's batch of last month's outing, uploaded this morning. The feed
   * is ordered by upload time, so they sit above posts they pre-date. With a small
   * `maxPageSize` they fill the first page, which is how a walk that stops at the first
   * page older than its cut-off loses the newer photos underneath them.
   */
  backDatedUploads?: number;
  /**
   * Media ids the CDN answers with 404, as it does for a post deleted on Brightwheel's
   * side. A signature that has merely expired is refused (403) instead; this is the
   * failure no retry can cure.
   */
  missingMediaIds?: string[];
}

const SESSION_COOKIE_NAME = '_brightwheel_v2';

const STUDENTS = [
  { object_id: 'stu-aaa-111', first_name: 'Robin', last_name: 'Maple', school: { name: 'Sunnybrook Early Learning' } },
  { object_id: 'stu-bbb-222', first_name: 'Sam', last_name: 'Maple', school: { name: 'Sunnybrook Early Learning' } },
];

const NOTES = [
  'Water play in the garden this morning.',
  'Painting with sponges. Very proud of this one.',
  'Fell asleep mid-song at circle time.',
  'First time down the big slide!',
  'Helped feed the class snails.',
  'Built a tower taller than they are.',
  'Sorting leaves by colour outside.',
  null,
];

const TEACHERS = ['Ms. Alvarez', 'Mr. Okafor', 'Ms. Lindqvist'];

/** Deterministic pseudo-random number from a string seed. */
function seeded(seed: string): () => number {
  let h = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  return () => {
    h = (Math.imul(h, 1103515245) + 12345) & 0x7fffffff;
    return h / 0x7fffffff;
  };
}

/**
 * Whoever posted the update, in the shape the real API uses.
 *
 * It used to be `{ name }`, which the real service does not have — so the parser read a
 * field that is never there, no archive ever recorded an author, and every test agreed with
 * the mistake because the mock was written from the same guess. Confirmed against the live
 * API on 2026-09-22: first_name, last_name, object_id, email and role. The email is
 * included here precisely because the parser must be seen NOT to take it.
 */
function actorFor(index: number) {
  // TEACHERS holds the courtesy title with the surname, as a nursery would write it, so the
  // whole of it is the "first name" the real API's first_name/last_name pair reconstructs to.
  const [title, surname] = TEACHERS[index % TEACHERS.length]!.split(' ') as [string, string];
  return {
    object_id: `stf-${surname.toLowerCase()}`,
    first_name: title,
    last_name: surname,
    email: `${surname.toLowerCase()}@sunnybrook.example`,
    user_type: 'staff',
    role: { is_administrator: false },
  };
}

/**
 * The child, as the activities feed actually embeds them.
 *
 * Confirmed against the live API on 2026-09-22: every activity record carries a `target`
 * object holding the child's `invite_code`, `raw_passcode`, both phone numbers and their
 * profile photo. The feed is therefore a second route to the family's contact details, not
 * only to photographs — and until this was checked, no fixture contained any of it, so the
 * test that asserts none of it reaches disk was only ever exercising `/users/me`.
 */
function targetFor(studentId: string) {
  const student = STUDENTS.find((s) => s.object_id === studentId) ?? STUDENTS[0]!;
  return {
    object_id: studentId,
    first_name: student.first_name,
    last_name: student.last_name,
    user_type: 'student',
    enrollment_status: 'enrolled',
    invite_code: 'INVITE-NEVER-STORE',
    raw_passcode: '4821',
    phone_1: '+15550000000',
    phone_2: null,
    auth_phone_number: '+15550000001',
    email: null,
    profile_photo: { object_id: 'pp-1', image_url: 'https://example.invalid/pp.jpg' },
  };
}

function buildActivities(
  studentId: string,
  count: number,
  baseUrl: string,
  issuedAt = 0,
  checkIns = 0,
  backDated = 0,
) {
  const rand = seeded(studentId);
  const out = [];
  // Walk backwards from a fixed date so runs are reproducible.
  const start = new Date('2026-09-18T15:30:00');
  /** A signed URL for one media id, minted fresh on every call exactly as a real CDN does. */
  const signed = (id: string, ext: string) =>
    `${baseUrl}/media/${id}.${ext}?signature=${issuedAt}.${Math.random().toString(36).slice(2, 12)}` +
    `&expires=${Date.now() + 900000}`;

  // Uploaded most recently, so first in the feed; taken two months before anything else.
  for (let i = 0; i < backDated; i++) {
    const when = new Date(start.getTime() - (60 + i) * 24 * 3600 * 1000);
    const id = `old-${studentId.slice(-3)}-${String(i).padStart(4, '0')}`;
    const url = signed(id, 'jpg');
    out.push({
      object_id: id,
      action_type: 'ac_photo',
      event_date: when.toISOString(),
      created_at: new Date(start.getTime() + 24 * 3600 * 1000).toISOString(),
      note: NOTES[i % NOTES.length],
      media: { image_url: url, thumbnail_url: url },
      video_info: null,
      actor: actorFor(i),
      target: targetFor(studentId),
    });
  }
  for (let i = 0; i < checkIns; i++) {
    // Newer than every photo, so they come first. Shaped like a real check-in: no media at all.
    const when = new Date(start.getTime() + (checkIns - i) * 3600 * 1000);
    out.push({
      object_id: `chk-${studentId.slice(-3)}-${String(i).padStart(4, '0')}`,
      action_type: 'ac_checkin',
      event_date: when.toISOString(),
      created_at: when.toISOString(),
      note: null,
      media: null,
      video_info: null,
      actor: actorFor(i),
      target: targetFor(studentId),
    });
  }
  for (let i = 0; i < count; i++) {
    const when = new Date(start.getTime() - i * (rand() * 8 + 4) * 3600 * 1000);
    const id = `act-${studentId.slice(-3)}-${String(i).padStart(4, '0')}`;
    const isVideo = i % 17 === 5;
    // The signature carries the request number that issued it, so
    // `mediaUrlExpiresAfterRequests` can age it deterministically.
    const url = signed(id, isVideo ? 'mp4' : 'jpg');
    // Mirrors the real record exactly: `object_id` not `id`; a photo carries
    // `media.image_url`; a video carries `video_info.downloadable_url` AND `media: null`.
    out.push({
      object_id: id,
      action_type: isVideo ? 'ac_video' : 'ac_photo',
      event_date: when.toISOString(),
      // Uploaded six hours after capture, so a test can prove we use event_date.
      created_at: new Date(when.getTime() + 6 * 3600 * 1000).toISOString(),
      note: NOTES[i % NOTES.length],
      media: isVideo ? null : { image_url: url, thumbnail_url: url },
      video_info: isVideo ? { downloadable_url: url } : null,
      actor: actorFor(i),
      target: targetFor(studentId),
    });
  }
  return out;
}

const LOGIN_PAGE = `<!doctype html><html><head><title>Sign in - brightwheel</title></head>
<body><h1>Sign in</h1><form><input name="email"><input name="password" type="password">
<button>Sign in</button></form></body></html>`;

export interface MockServer {
  url: string;
  port: number;
  close: () => Promise<void>;
  /** Every request served, in order. `search` is the query string, so a test can tell pages apart. */
  requests: { method: string; path: string; search: string }[];
}

export async function startMockBrightwheel(options: MockOptions = {}): Promise<MockServer> {
  const validSession = options.validSession ?? 'test-session-value';
  const perStudent = options.activitiesPerStudent ?? 24;
  const requests: { method: string; path: string; search: string }[] = [];
  let apiRequests = 0;

  let baseUrl = '';

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', baseUrl || 'http://127.0.0.1');
    requests.push({ method: req.method ?? 'GET', path: url.pathname, search: url.search });

    const cookie = req.headers.cookie ?? '';
    const isMedia = url.pathname.startsWith('/media/');
    if (!isMedia) apiRequests += 1;
    const sessionExpired =
      options.forceExpired ||
      (options.expireSessionAfterRequests !== undefined && apiRequests > options.expireSessionAfterRequests);
    const authed = !sessionExpired && cookie.includes(`_brightwheel_v2=${validSession}`);

    // Media is served regardless of path shape, so signed-URL churn is exercised.
    if (isMedia) {
      // Mirror the real CDN: the URL signature IS the authorisation, and presenting the
      // Brightwheel session cookie is rejected outright. Asserting that here turns a
      // subtle production-only failure into a test failure — sending the session to the
      // media host is both broken and a needless exposure of an account-takeover
      // credential to a second origin.
      if (cookie.includes(`${SESSION_COOKIE_NAME}=`)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('permission denied: do not send the session cookie to the media host');
        return;
      }
      const signature = url.searchParams.get('signature');
      if (!signature) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('missing signature');
        return;
      }
      const ttl = options.mediaUrlExpiresAfterRequests;
      if (ttl !== undefined && requests.length - Number(signature.split('.')[0]) > ttl) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('signature expired');
        return;
      }
      const expires = url.searchParams.get('expires');
      if (options.enforceMediaUrlExpiry && expires !== null && Number(expires) < Date.now()) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('url expired');
        return;
      }
      const id = url.pathname.replace('/media/', '').replace(/\.[a-z0-9]+$/i, '');
      // Gone from the CDN, not merely stale: the post was deleted on Brightwheel's side.
      if (options.missingMediaIds?.includes(id)) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      const isVideo = /\.mp4$/i.test(url.pathname);
      const body = isVideo ? placeholderMp4(id) : placeholderJpeg(id);
      res.writeHead(200, {
        'content-type': isVideo ? 'video/mp4' : 'image/jpeg',
        'content-length': body.length,
        etag: `"${createHash('sha256').update(id).digest('hex').slice(0, 16)}"`,
        'last-modified': new Date('2026-09-18T12:00:00Z').toUTCString(),
      });
      res.end(body);
      return;
    }

    if (!authed) {
      // The trap this project cares about: HTTP 200 with an HTML sign-in page.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(LOGIN_PAGE);
      return;
    }

    const json = (body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(text);
    };

    if (url.pathname === '/api/v1/users/me') {
      // Flat record with object_id, matching the real fixture. The passcode/invite/phone
      // fields are included on purpose: they are present in the real response, and a test
      // asserts we never write them to disk.
      json({
        object_id: 'guardian-xyz-999',
        email: 'parent@example.com',
        first_name: 'Alex',
        last_name: 'Maple',
        user_type: 'guardian',
        raw_passcode: '4821',
        invite_code: 'INVITE-NEVER-STORE',
        auth_phone_number: '+15550000000',
        phone_1: '+15550000001',
      });
      return;
    }
    if (/^\/api\/v1\/guardians\/[^/]+\/students$/.test(url.pathname)) {
      json({
        count: STUDENTS.length,
        students: STUDENTS.map((s) => ({
          relationship_type: 'parent',
          guardian_id: 'guardian-xyz-999',
          student: s,
        })),
      });
      return;
    }
    const m = url.pathname.match(/^\/api\/v1\/students\/([^/]+)\/activities$/);
    if (m?.[1]) {
      const page = Number(url.searchParams.get('page') ?? '0');
      const size = Math.min(Number(url.searchParams.get('page_size') ?? '100'), options.maxPageSize ?? Infinity);
      let all = buildActivities(
        m[1],
        perStudent,
        baseUrl,
        requests.length,
        options.leadingCheckIns,
        options.backDatedUploads,
      );
      // Honour the server-side filters the real API supports.
      const actionType = url.searchParams.get('action_type');
      if (actionType) all = all.filter((a) => a.action_type === actionType);
      const startDate = url.searchParams.get('start_date');
      if (startDate) all = all.filter((a) => a.event_date >= startDate);
      const endDate = url.searchParams.get('end_date');
      if (endDate) all = all.filter((a) => a.event_date <= endDate);
      json({
        count: all.length,
        offset: page * size,
        page,
        page_size: size,
        activities: all.slice(page * size, page * size + size),
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    url: baseUrl,
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
