import { DEFAULT_BASE_URL, MAX_RESPONSE_BYTES, apiHeaders } from './api/client.js';
import { BodyTooLargeError, readBodyText } from './http-body.js';
import { assertJsonResponse } from './api/schema.js';
import { browserUserAgent } from './api/identity.js';
import { parseWithheld } from './api/withheld.js';
import { scrub } from './secrets.js';
import type { Secret } from './secrets.js';
import { checkBaseUrl, refuseLiveApiUnderTest } from './config.js';
import { loopbackOrigin, mediaUrlRefusal } from './ferry/url.js';

/**
 * A bounded, read-only check of the live Brightwheel API that reveals SHAPE, never CONTENT.
 *
 * The field names in this project were first taken from other people's open-source clients
 * and sanitized fixtures, and were checked against one live account on 2026-09-21 and
 * 2026-09-22. This command is how anyone re-checks them on their own account, without
 * archiving anything and — importantly — without printing a single child's name, photo,
 * note or identifier.
 *
 * The rule it follows: report whether a field is PRESENT and what TYPE it is. Never report
 * its value. There are two deliberate exceptions, each the answer to a question the project
 * cannot settle any other way: whether event_date differs from created_at (identical on
 * every record of the one account checked; worth measuring on another nursery — reported as
 * a count and the largest gap in minutes), and which company serves the media (reported as
 * a domain, never the full host name — see where it is pushed).
 *
 * It also sends the session to exactly one place: the Brightwheel API. The obvious extra
 * check — "does the media CDN reject the session cookie?" — is the one thing this tool
 * promises never to do, so it is not done and the report says so instead.
 *
 * Without --deep it makes four requests (three to the API, one HEAD to the media host
 * without the session) and downloads no media; with --deep it also downloads up to three
 * photos to a temporary directory, reads them and deletes them. A media address is asked only
 * if it passes the rule downloads keep (`fetchMedia`).
 */

export interface FieldCheck {
  field: string;
  present: boolean;
  type: string;
  note?: string;
}

export interface VerifyReport {
  reachable: boolean;
  sessionValid: boolean;
  checks: { endpoint: string; fields: FieldCheck[] }[];
  findings: string[];
  warnings: string[];
}

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

function check(obj: Record<string, unknown>, fields: string[]): FieldCheck[] {
  return fields.map((field) => {
    const parts = field.split('.');
    let cur: unknown = obj;
    for (const part of parts) {
      cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined;
    }
    return { field, present: cur !== undefined && cur !== null, type: typeOf(cur) };
  });
}

/**
 * One read, with the failure named by a LABEL rather than by its URL.
 *
 * `label` is the whole point of this signature. The hand-rolled check this replaced put
 * `path` into its error, and two of the three paths here carry an id — so a session that
 * died between the first request and the second printed
 * `Expected JSON from /guardians/<object_id>/students`, an identifier, in a report this
 * command promises contains none. The shared `assertJsonResponse` raises SessionExpiredError
 * for a login page (whose message carries nothing at all) and otherwise names only what it
 * is given, which is why it is given a word and not a URL.
 */
/** Why a media address was not asked. Its message never carries the address. */
class MediaNotFetched extends Error {}

/** The redirect statuses fetch would follow on its own, and as many as it follows. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_MEDIA_REDIRECTS = 20;

/**
 * A media address from the feed, asked under the rule download() keeps (security review §4.6,
 * F3): https, no user name or password, not this computer or the local network
 * (`mediaUrlRefusal`), with the API's own origin trusted only when the API is on this
 * computer. Redirects are followed by hand, each one held to the same rule. Without this,
 * `verify` asked whatever address the feed named, so a feed could have it probe the parent's
 * own network and print the answer in a report they are told is safe to share.
 */
async function fetchMedia(
  start: string,
  init: RequestInit,
  trustedOrigin: string | null,
  doFetch: typeof fetch,
): Promise<Response> {
  const first = mediaUrlRefusal(start, trustedOrigin);
  if (first) throw new MediaNotFetched(`the feed's media address was not asked, because ${first}.`);
  let current = new URL(start);
  for (let hops = 0; ; hops += 1) {
    const response = await doFetch(current.href, { ...init, redirect: 'manual' });
    if (!REDIRECTS.has(response.status)) return response;
    await response.body?.cancel().catch(() => {});
    const location = response.headers.get('location');
    let next: URL;
    try {
      if (!location) throw new Error('no location');
      next = new URL(location, current);
    } catch {
      throw new MediaNotFetched('the media host redirected to an address that could not be read.');
    }
    if (hops >= MAX_MEDIA_REDIRECTS) {
      throw new MediaNotFetched(`the media host redirected more than ${MAX_MEDIA_REDIRECTS} times.`);
    }
    const refused = mediaUrlRefusal(next.href, trustedOrigin);
    if (refused) {
      throw new MediaNotFetched(`the media host redirected to an address this tool does not fetch from, because ${refused}.`);
    }
    current = next;
  }
}

async function raw(
  path: string,
  label: string,
  session: Secret,
  baseUrl: string,
  fetchImpl: typeof fetch,
  withheld: Set<string>,
): Promise<Record<string, unknown>> {
  // The browser identity is added by the fetch this is handed, as to every request here.
  const response = await fetchImpl(`${baseUrl}${path}`, { headers: apiHeaders(session) });
  // Capped while it is read, as the client's own requests are (security review outbound-7):
  // this command reads the same endpoints, and an endless or bomb-sized answer here would
  // fill memory as surely as one to a run.
  let text: string;
  try {
    text = await readBodyText(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    if (!(error instanceof BodyTooLargeError)) throw error;
    throw new Error(
      `Brightwheel's answer from ${label} was larger than ${MAX_RESPONSE_BYTES / (1024 * 1024)} MB, far more than it ever sends, so it was not read.`,
    );
  }
  assertJsonResponse(response, text, label);
  // Parsed as a run parses it, without the check-in codes and the rest (api/withheld.ts):
  // this command reads the same answers, and must not be the one place that holds them.
  try {
    return parseWithheld(text, withheld) as Record<string, unknown>;
  } catch {
    // JSON.parse's own message quotes the text around the fault, which may be a code.
    throw new Error(`Brightwheel's answer from ${label} was not JSON that could be read.`);
  }
}

export async function verify(
  session: Secret,
  options: { baseUrl?: string; fetchImpl?: typeof fetch; deep?: boolean; userAgent?: string | null } = {},
): Promise<VerifyReport> {
  // This command composes its own requests, so it makes the command line's two refusals
  // itself: no session in the clear to anywhere but this computer (security review
  // outbound-13), and none to the real Brightwheel from a test (docs-14). A caller that hands
  // in its own fetch reaches no network through this, so the second does not apply to it.
  if (options.baseUrl !== undefined) checkBaseUrl(options.baseUrl);
  if (!options.fetchImpl) refuseLiveApiUnderTest(options.baseUrl);
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  // Every request this command makes carries the same browser identity a run does, the
  // media ones included. Left to itself, fetch would announce `node` on each of them.
  const userAgent = options.userAgent || browserUserAgent();
  const baseFetch = options.fetchImpl ?? fetch;
  const doFetch: typeof fetch = (input, init = {}) =>
    baseFetch(input, { ...init, headers: { ...((init.headers as Record<string, string>) ?? {}), 'User-Agent': userAgent } });
  const trustedMedia = loopbackOrigin(baseUrl);
  const askMedia = (url: string, init: RequestInit = {}) => fetchMedia(url, init, trustedMedia, doFetch);
  const report: VerifyReport = { reachable: false, sessionValid: false, checks: [], findings: [], warnings: [] };
  // The names of the fields dropped as the answers were read, never their values.
  const withheld = new Set<string>();

  // 1 — the account.
  const me = await raw('/users/me', 'the account endpoint', session, baseUrl, doFetch, withheld);
  report.reachable = true;
  const meObj = (me.object as Record<string, unknown>) ?? me;
  report.sessionValid = Boolean(meObj.object_id ?? meObj.id);
  report.checks.push({
    endpoint: 'GET /users/me',
    fields: check(meObj, ['object_id', 'id', 'email', 'user_type', 'first_name']),
  });
  if (meObj.object_id && !meObj.id) report.findings.push('CONFIRMED: the account id field is `object_id`, not `id`.');
  if (meObj.id && !meObj.object_id) report.findings.push('CONTRADICTED: this account uses `id`, not `object_id`.');

  const guardianId = String(meObj.object_id ?? meObj.id);

  // 2 — the children. Count only; no names.
  const students = await raw(
    `/guardians/${encodeURIComponent(guardianId)}/students?include[]=schools`,
    'the children endpoint',
    session,
    baseUrl,
    doFetch,
    withheld,
  );
  const list = (students.students ?? students.data ?? []) as unknown[];
  report.checks.push({
    endpoint: 'GET /guardians/{id}/students',
    fields: [
      {
        field: 'students',
        present: Array.isArray(list),
        type: typeOf(list),
        // How many children are on the account is a fact about the family, not about the
        // shape of the API, and this report is meant to be safe to paste into a public
        // issue. "Empty or not" answers the only question the shape check is asking.
        note: list.length === 0 ? 'empty' : 'at least one entry',
      },
      ...(list[0] ? check(list[0] as Record<string, unknown>, ['student', 'student.object_id', 'student.first_name', 'relationship_type']) : []),
    ],
  });
  const first = list[0] as Record<string, unknown> | undefined;
  const studentObj = (first?.student as Record<string, unknown>) ?? first;
  if (first?.student) report.findings.push('CONFIRMED: each entry nests the child under `.student`.');
  const studentId = studentObj ? String(studentObj.object_id ?? studentObj.id) : null;

  // 3 — one page of up to 50 photo activities.
  if (studentId) {
    const query = new URLSearchParams({
      page: '0',
      // Enough records to answer the timestamp question. One was not: on a real account the
      // first photo of the page had an identical event_date and created_at, which says
      // nothing either way — a teacher who posts immediately produces exactly that. The
      // question is whether the two EVER differ, so the sample has to be big enough to
      // contain a photo somebody uploaded later. Still one request, still no downloads.
      page_size: '50',
      include_parent_actions: 'false',
      action_type: 'ac_photo',
    });
    const acts = await raw(
      `/students/${encodeURIComponent(studentId)}/activities?${query}`,
      'the activities endpoint',
      session,
      baseUrl,
      doFetch,
      withheld,
    );
    const items = (acts.activities ?? acts.data ?? []) as unknown[];
    report.checks.push({
      endpoint: 'GET /students/{id}/activities?action_type=ac_photo',
      fields: [
        ...check(acts, ['count', 'offset', 'page', 'page_size']),
        { field: 'activities', present: Array.isArray(items), type: typeOf(items), note: `${items.length} returned` },
        ...(items[0]
          ? check(items[0] as Record<string, unknown>, [
              'object_id', 'id', 'action_type', 'event_date', 'created_at',
              'note', 'media', 'media.image_url', 'video_info',
              'actor.first_name', 'actor.last_name',
            ])
          : []),
      ],
    });

    if (items.length > 0) {
      report.findings.push(
        'ACCEPTED, NOT CONFIRMED: `action_type=ac_photo` returned a non-empty page; whether the ' +
          'server filters on it or ignores it is not checked here.',
      );
    } else {
      report.warnings.push('`action_type=ac_photo` returned nothing — the filter value may differ.');
    }

    // Every field name a record carries, so that a question like "is the capture time in
    // here at all?" can be answered by looking rather than by guessing at spellings. Names
    // and types only — a field's VALUE is the thing that could name a family.
    if (items.length > 0) {
      const shapes = new Map<string, string>();
      const walk = (value: unknown, prefix: string, depth: number): void => {
        if (depth > 2 || value === null || typeof value !== 'object' || Array.isArray(value)) return;
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          const path = prefix ? `${prefix}.${k}` : k;
          shapes.set(path, typeOf(v));
          walk(v, path, depth + 1);
        }
      };
      for (const item of items) walk(item, '', 0);
      report.checks.push({
        endpoint: 'Every field name on a photo record (names and types only)',
        fields: [...shapes].sort(([a], [b]) => (a < b ? -1 : 1)).map(([field, type]) => ({
          field,
          present: true,
          type,
        })),
      });
    }

    // Whether event_date and created_at ever differ, across every record on the page. On the
    // one account checked they never did.
    const pairs = items
      .map((item) => item as Record<string, unknown>)
      .filter((item) => typeof item.event_date === 'string' && typeof item.created_at === 'string')
      .map((item) => ({
        ev: new Date(item.event_date as string),
        cr: new Date(item.created_at as string),
      }))
      .filter((p) => !Number.isNaN(p.ev.getTime()) && !Number.isNaN(p.cr.getTime()));

    if (pairs.length > 0) {
      const diffs = pairs.map((p) => Math.round((p.cr.getTime() - p.ev.getTime()) / 60000));
      const differing = diffs.filter((d) => d !== 0);
      const laterUploads = diffs.filter((d) => d > 0).length;
      const sameDayBreak = pairs.filter(
        (p) => p.ev.toDateString() !== p.cr.toDateString(),
      ).length;
      if (differing.length === 0) {
        report.findings.push(
          `INCONCLUSIVE: on all ${pairs.length} records event_date equals created_at. Either this ` +
            'nursery always posts immediately, or the two fields carry the same thing. Worth ' +
            're-running when a photo has been posted some hours after it was taken.',
        );
      } else {
        const biggest = Math.max(...differing.map(Math.abs));
        report.findings.push(
          `CONFIRMED: event_date and created_at differ on ${differing.length} of ${pairs.length} records ` +
            `(largest gap ${biggest} minutes, ${laterUploads} uploaded after the moment recorded). ` +
            'On this account the two differ, so event_date may be a real capture time. That would be ' +
            'new — on the account checked in September 2026 they were identical on every record. ' +
            'Please open an issue with this line; it is worth confirming.',
        );
        if (sameDayBreak > 0) {
          report.findings.push(
            `${sameDayBreak} of those cross midnight, so using created_at would file them under the ` +
              'wrong day — and at a week boundary, the wrong folder.',
          );
        }
      }
    }

    // Only with --deep — the question nothing else can answer.
    //
    // event_date and created_at are the same on every record of a real account, so
    // Brightwheel's API does not tell us when a photo was TAKEN, only when it was posted.
    // If the moment survives anywhere it is inside the image, where the camera wrote it.
    // Finding out means downloading up to three photos, which is why it is not the default:
    // the rest of this command downloads no media.
    //
    // The photos go to a temporary directory, their metadata is read, and the directory is
    // deleted in a finally. Nothing about them is printed except whether a capture date
    // exists, how far it is from the posted time, and whether GPS coordinates remain.
    if (options.deep) {
      const withMedia = items
        .map((item) => item as Record<string, unknown>)
        .filter((item) => typeof (item.media as Record<string, unknown>)?.image_url === 'string')
        .slice(0, 3);
      if (withMedia.length === 0) {
        report.warnings.push('--deep found no photo to examine on this page.');
      } else {
        const probe = await probeCaptureTimes(withMedia, askMedia);
        report.findings.push(...probe);
      }
    }

    const a = items[0] as Record<string, unknown> | undefined;
    if (a) {
      const mediaUrl =
        ((a.media as Record<string, unknown>)?.image_url as string) ??
        ((a.video_info as Record<string, unknown>)?.downloadable_url as string);
      if (mediaUrl) {
        report.findings.push('CONFIRMED: media lives at `media.image_url` / `video_info.downloadable_url`.');
        try {
          const u = new URL(mediaUrl);
          const signed = [...u.searchParams.keys()].some((k) =>
            /signature|expires|x-amz|x-goog|token|policy/i.test(k),
          );
          report.findings.push(
            signed
              ? `CONFIRMED: media URLs are signed and expiring (params: ${[...u.searchParams.keys()].join(', ')}).`
              : 'NOTE: this media URL carries no signature parameters — signature-stripping may be unnecessary.',
          );
          // The domain, not the whole host name. Which company serves the media is a real
          // answer to a real question — is it Brightwheel's own origin or a bucket at a
          // cloud provider? — but the labels in front of it need not be neutral: a
          // per-tenant bucket can carry a nursery's name, and a report a parent is told to
          // paste into a public issue must not carry the name of their child's nursery.
          const domain = u.hostname.split('.').slice(-2).join('.');
          const apiHost = new URL(baseUrl).hostname;
          report.findings.push(
            `Media is served from ${domain}, ` +
              (u.hostname === apiHost ? 'the same host as the API.' : 'a different host from the API.') +
              ' The full host name is left out of this report in case it names your nursery.',
          );

          // 4 — the media host, asked the way a download asks it: signature only, no
          // session. The tempting fifth request is "and what does it say WITH the cookie?",
          // which is exactly the thing `BrightwheelClient.mediaHeaders` exists never to do
          // and the README promises never happens. A command whose job is to verify the
          // tool's claims cannot be the one place that breaks one of them, so the question
          // goes unanswered and the report says that plainly rather than quietly omitting
          // it. The useful half — "is the signature alone enough?" — is what downloading
          // actually depends on, and that is the half kept.
          let without: Response | null = null;
          try {
            without = await askMedia(mediaUrl, { method: 'HEAD' });
          } catch (error) {
            if (!(error instanceof MediaNotFetched)) throw error;
            report.warnings.push(
              `Media fetch WITHOUT the session cookie: not attempted, because ${error.message} ` +
                'A run would refuse this photo in the same way.',
            );
          }
          if (without) {
            report.findings.push(
              `Media fetch WITHOUT the session cookie: HTTP ${without.status}.` +
                (without.ok
                  ? ' CONFIRMED: the URL signature alone is enough, which is what downloading relies on.'
                  : ' Unexpected — investigate before trusting downloads.'),
            );
          }
          report.findings.push(
            'NOT CHECKED, deliberately: what the media host does WITH the session cookie. ' +
              'This tool sends your Brightwheel session to the Brightwheel API and nowhere ' +
              'else, so it cannot report what would happen if it did.',
          );
        } catch (error) {
          // Scrubbed: a failure here is reported to a parent who has been told this output
          // is safe to share, and an error thrown while handling a signed URL is one of the
          // few places that URL could turn up in a message.
          report.warnings.push(
            `Could not probe the media URL: ${scrub(error instanceof Error ? error.message : String(error))}`,
          );
        }
      } else {
        report.warnings.push('No media URL found on the first photo activity — the media field has moved.');
      }
    }
  }

  if (withheld.size > 0) {
    report.findings.push(
      `WITHHELD: Brightwheel sent ${[...withheld].sort().map((name) => `\`${name}\``).join(', ')}, ` +
        'which were dropped as the answers were read and never held (api/withheld.ts).',
    );
  }
  return report;
}

/**
 * Download a few photos to a temporary directory, read the date the camera wrote, delete
 * them. Used only by `verify --deep`.
 *
 * Deliberately narrow about what it reports: whether the file carries its own capture time,
 * how many minutes earlier that is than the moment Brightwheel recorded, and whether the
 * file still carries GPS coordinates. It never prints the date itself, the filename, the
 * URL, or anything else the file contains.
 */
async function probeCaptureTimes(
  items: Record<string, unknown>[],
  askMedia: (url: string) => Promise<Response>,
): Promise<string[]> {
  let exiftool: { read: (f: string) => Promise<Record<string, unknown>>; end: () => Promise<void> };
  try {
    ({ exiftool } = (await import('exiftool-vendored')) as unknown as {
      exiftool: { read: (f: string) => Promise<Record<string, unknown>>; end: () => Promise<void> };
    });
  } catch {
    return ['--deep needs ExifTool, which is not installed, so the photo could not be read.'];
  }

  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'bw-verify-'));
  const out: string[] = [];
  let withOwnDate = 0;
  let withGps = 0;
  const gaps: number[] = [];

  try {
    for (const [i, item] of items.entries()) {
      const url = (item.media as Record<string, unknown>).image_url as string;
      let response: Response;
      try {
        response = await askMedia(url);
      } catch (error) {
        if (!(error instanceof MediaNotFetched)) throw error;
        out.push(`--deep did not fetch a photo to examine: ${error.message}`);
        continue;
      }
      if (!response.ok) {
        out.push(`--deep could not fetch a photo to examine (HTTP ${response.status}).`);
        continue;
      }
      const file = join(dir, `probe-${i}.jpg`);
      await writeFile(file, Buffer.from(await response.arrayBuffer()));
      const tags = await exiftool.read(file);
      const own = tags.DateTimeOriginal ?? tags.CreateDate ?? null;
      const owned = own ? new Date(String(own)) : null;
      if (owned && !Number.isNaN(owned.getTime())) {
        withOwnDate += 1;
        const posted = new Date(item.event_date as string);
        if (!Number.isNaN(posted.getTime())) {
          gaps.push(Math.round((posted.getTime() - owned.getTime()) / 60000));
        }
      }
      if (tags.GPSLatitude !== undefined || tags.GPSPosition !== undefined) withGps += 1;
    }
  } finally {
    await exiftool.end().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }

  if (withOwnDate === 0) {
    out.push(
      `DEEP: none of the ${items.length} photos examined carries a capture time of its own. ` +
        'Brightwheel strips it, or the posting app never wrote one — so the moment a photo ' +
        'was taken is not recoverable, and the posted time is the best date there is.',
    );
  } else {
    const biggest = gaps.length > 0 ? Math.max(...gaps.map(Math.abs)) : 0;
    out.push(
      `DEEP: ${withOwnDate} of ${items.length} photos carry their own capture time, ` +
        `up to ${biggest} minutes before the moment Brightwheel recorded. That is the real ` +
        'capture time, and it is inside the file rather than in the API.',
    );
  }
  out.push(
    withGps > 0
      ? `DEEP: ${withGps} of the photos examined still carry GPS coordinates. Leaving "remove ` +
        'location information" on matters on this account.'
      : 'DEEP: none of the photos examined carries GPS coordinates.',
  );
  out.push('DEEP: every photo downloaded for this check was deleted before this report was printed.');
  return out;
}

/** Render the report as text that is safe to paste into a public issue. */
export function formatReport(report: VerifyReport): string {
  const lines: string[] = [
    '',
    '  Brightwheel API verification (read-only; --deep also reads up to three photos, then deletes them)',
    '  Mostly field names and types. Never a name, note, id or photo; the few values shown are listed in the README.',
    '',
    `  Reachable:     ${report.reachable ? 'yes' : 'no'}`,
    `  Session valid: ${report.sessionValid ? 'yes' : 'no'}`,
    '',
  ];
  for (const { endpoint, fields } of report.checks) {
    lines.push(`  ${endpoint}`);
    for (const f of fields) {
      const mark = f.present ? 'ok  ' : 'MISS';
      lines.push(`    ${mark} ${f.field.padEnd(26)} ${f.type}${f.note ? `  (${f.note})` : ''}`);
    }
    lines.push('');
  }
  if (report.findings.length) {
    lines.push('  Findings');
    for (const f of report.findings) lines.push(`    - ${f}`);
    lines.push('');
  }
  if (report.warnings.length) {
    lines.push('  Warnings');
    for (const w of report.warnings) lines.push(`    ! ${w}`);
    lines.push('');
  }
  return lines.join('\n');
}
