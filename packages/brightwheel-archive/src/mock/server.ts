import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';

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
 * The photos are generated SVG-to-PNG-ish placeholders drawn from the activity id, so the
 * same fake photo always looks the same and the screenshots are reproducible.
 */

export interface MockOptions {
  /** Session value that counts as valid. Anything else gets the login page. */
  validSession?: string;
  /** Number of media activities to generate per student. */
  activitiesPerStudent?: number;
  /** Simulate an expired session for every request. */
  forceExpired?: boolean;
}

const SESSION_COOKIE_NAME = '_brightwheel_v2';

const STUDENTS = [
  { id: 'stu-aaa-111', first_name: 'Robin', last_name: 'Maple', school: { name: 'Sunnybrook Early Learning' } },
  { id: 'stu-bbb-222', first_name: 'Sam', last_name: 'Maple', school: { name: 'Sunnybrook Early Learning' } },
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

/** A coloured placeholder "photo" as an SVG, deterministic per id. */
function placeholderSvg(id: string, label: string): string {
  const rand = seeded(id);
  const hue = Math.floor(rand() * 360);
  const hue2 = (hue + 40 + Math.floor(rand() * 80)) % 360;
  const shapes = Array.from({ length: 6 }, (_, i) => {
    const cx = Math.floor(rand() * 800);
    const cy = Math.floor(rand() * 600);
    const r = 40 + Math.floor(rand() * 120);
    const h = (hue + i * 30) % 360;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsl(${h} 70% 68%)" opacity="0.55"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="hsl(${hue} 65% 78%)"/><stop offset="100%" stop-color="hsl(${hue2} 65% 62%)"/>
</linearGradient></defs>
<rect width="800" height="600" fill="url(#g)"/>${shapes}
<text x="400" y="300" font-family="system-ui,sans-serif" font-size="34" font-weight="600"
 fill="rgba(255,255,255,.92)" text-anchor="middle">${label}</text>
<text x="400" y="344" font-family="system-ui,sans-serif" font-size="19"
 fill="rgba(255,255,255,.75)" text-anchor="middle">sample image - not a real child</text>
</svg>`;
}

function buildActivities(studentId: string, count: number, baseUrl: string) {
  const rand = seeded(studentId);
  const out = [];
  // Walk backwards from a fixed date so runs are reproducible.
  const start = new Date('2026-09-18T15:30:00');
  for (let i = 0; i < count; i++) {
    const when = new Date(start.getTime() - i * (rand() * 8 + 4) * 3600 * 1000);
    const id = `act-${studentId.slice(-3)}-${String(i).padStart(4, '0')}`;
    const isVideo = i % 17 === 5;
    // A fresh signature every call, exactly as a real CDN behaves.
    const sig = Math.random().toString(36).slice(2, 12);
    out.push({
      id,
      action_type: isVideo ? 'ac_video' : 'ac_photo',
      event_date: when.toISOString(),
      created_at: new Date(when.getTime() + 6 * 3600 * 1000).toISOString(),
      note: NOTES[i % NOTES.length],
      media_url: `${baseUrl}/media/${id}.${isVideo ? 'mp4' : 'jpg'}?signature=${sig}&expires=${Date.now() + 900000}`,
      actor: { name: TEACHERS[i % TEACHERS.length] },
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
  requests: { method: string; path: string }[];
}

export async function startMockBrightwheel(options: MockOptions = {}): Promise<MockServer> {
  const validSession = options.validSession ?? 'test-session-value';
  const perStudent = options.activitiesPerStudent ?? 24;
  const requests: { method: string; path: string }[] = [];

  let baseUrl = '';

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', baseUrl || 'http://127.0.0.1');
    requests.push({ method: req.method ?? 'GET', path: url.pathname });

    const cookie = req.headers.cookie ?? '';
    const authed = !options.forceExpired && cookie.includes(`_brightwheel_v2=${validSession}`);

    // Media is served regardless of path shape, so signed-URL churn is exercised.
    if (url.pathname.startsWith('/media/')) {
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
      if (!url.searchParams.get('signature')) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('missing signature');
        return;
      }
      const id = url.pathname.replace('/media/', '').replace(/\.[a-z0-9]+$/i, '');
      const svg = placeholderSvg(id, id);
      res.writeHead(200, {
        'content-type': 'image/svg+xml',
        'content-length': Buffer.byteLength(svg),
        etag: `"${createHash('sha256').update(id).digest('hex').slice(0, 16)}"`,
        'last-modified': new Date('2026-09-18T12:00:00Z').toUTCString(),
      });
      res.end(svg);
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
      json({ object: { id: 'guardian-xyz-999', email: 'parent@example.com' } });
      return;
    }
    if (/^\/api\/v1\/guardians\/[^/]+\/students$/.test(url.pathname)) {
      json({ students: STUDENTS.map((s) => ({ student: s })) });
      return;
    }
    const m = url.pathname.match(/^\/api\/v1\/students\/([^/]+)\/activities$/);
    if (m?.[1]) {
      const page = Number(url.searchParams.get('page') ?? '0');
      const size = Number(url.searchParams.get('page_size') ?? '100');
      const all = buildActivities(m[1], perStudent, baseUrl);
      json({ activities: all.slice(page * size, page * size + size) });
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
