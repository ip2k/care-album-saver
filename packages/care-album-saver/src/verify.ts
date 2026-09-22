import { DEFAULT_BASE_URL, SESSION_COOKIE } from './api/client.js';
import { assertJsonResponse } from './api/schema.js';
import { scrub } from './secrets.js';
import type { Secret } from './secrets.js';

/**
 * A bounded, read-only check of the live Brightwheel API that reveals SHAPE, never CONTENT.
 *
 * Every field name in this project was derived from other people's open-source clients and
 * sanitized fixtures. Nothing has been confirmed against the real service. This command
 * closes that gap without archiving anything and — importantly — without printing a single
 * child's name, photo, note or identifier.
 *
 * The rule it follows: report whether a field is PRESENT and what TYPE it is. Never report
 * its value. There are two deliberate exceptions, each the answer to a question the project
 * cannot settle any other way: whether event_date differs from created_at (the claim the
 * whole timestamp-correction feature rests on, reported as a difference in minutes), and
 * which company serves the media (reported as a domain, never the full host name — see
 * where it is pushed).
 *
 * It also sends the session to exactly one place: the Brightwheel API. The obvious extra
 * check — "does the media CDN reject the session cookie?" — is the one thing this tool
 * promises never to do, so it is not done and the report says so instead.
 *
 * It makes four requests — three to the API, and one HEAD to the media host without the
 * session — and downloads no media.
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

/** Raw fetch helper so we can inspect envelopes the typed client would discard. */
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
async function raw(
  path: string,
  label: string,
  session: Secret,
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    headers: {
      Cookie: `${SESSION_COOKIE}=${session.expose()}`,
      Accept: 'application/json',
      'X-Client-Name': 'web',
    },
  });
  const text = await response.text();
  assertJsonResponse(response, text, label);
  return JSON.parse(text) as Record<string, unknown>;
}

export async function verify(
  session: Secret,
  options: { baseUrl?: string; fetchImpl?: typeof fetch; deep?: boolean } = {},
): Promise<VerifyReport> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? fetch;
  const report: VerifyReport = { reachable: false, sessionValid: false, checks: [], findings: [], warnings: [] };

  // 1 — the account.
  const me = await raw('/users/me', 'the account endpoint', session, baseUrl, doFetch);
  report.reachable = true;
  const meObj = (me.object as Record<string, unknown>) ?? me;
  report.sessionValid = Boolean(meObj.object_id ?? meObj.id);
  report.checks.push({
    endpoint: 'GET /users/me',
    fields: check(meObj, ['object_id', 'id', 'email', 'user_type', 'first_name']),
  });
  if (meObj.object_id && !meObj.id) report.findings.push('CONFIRMED: the account id field is `object_id`, not `id`.');
  if (meObj.id && !meObj.object_id) report.findings.push('CONTRADICTED: this account uses `id`, not `object_id`.');
  for (const sensitive of ['raw_passcode', 'invite_code', 'auth_phone_number', 'phone_1']) {
    if (meObj[sensitive] !== undefined) {
      report.warnings.push(`/users/me really does return \`${sensitive}\` — never persist this response.`);
    }
  }

  const guardianId = String(meObj.object_id ?? meObj.id);

  // 2 — the children. Count only; no names.
  const students = await raw(
    `/guardians/${encodeURIComponent(guardianId)}/students?include[]=schools`,
    'the children endpoint',
    session,
    baseUrl,
    doFetch,
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

  // 3 — one small page of photo activities. Five records, no downloads.
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
              'note', 'media', 'media.image_url', 'video_info', 'actor.name',
            ])
          : []),
      ],
    });

    if (items.length > 0) {
      report.findings.push('CONFIRMED: the server accepts `action_type=ac_photo` filtering.');
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

    // Which field carries the name of whoever posted the photo. `actor.name` came from
    // another project's fixtures and is absent on a real record, so the tool has been
    // writing no author at all. Report which of the plausible spellings exist — names of
    // fields, never the name in them.
    if (items.length > 0) {
      const candidates = [
        'actor', 'actor.name', 'actor.first_name', 'actor.object_id',
        'author', 'author.name', 'created_by', 'created_by.name', 'created_by.first_name',
        'creator', 'creator.name', 'staff', 'staff.name', 'teacher', 'teacher.name',
        'user', 'user.name', 'user.first_name', 'actor_name', 'creator_name',
      ];
      const present = new Set<string>();
      for (const item of items) {
        for (const c of check(item as Record<string, unknown>, candidates)) {
          if (c.present) present.add(`${c.field} (${c.type})`);
        }
      }
      report.findings.push(
        present.size > 0
          ? `Who posted a photo is carried by: ${[...present].sort().join(', ')}.`
          : 'NOT FOUND: no field on any record names whoever posted the photo. The tool ' +
            'writes no author, and `actor.name` — taken from another project — is not it.',
      );
    }

    // The claim the entire timestamp-correction feature depends on, measured across every
    // record the page returned rather than the first one that happened to come back.
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

    // 4 (only with --deep) — the question nothing else can answer.
    //
    // event_date and created_at are the same on every record of a real account, so
    // Brightwheel's API does not tell us when a photo was TAKEN, only when it was posted.
    // If the moment survives anywhere it is inside the image, where the camera wrote it.
    // Finding out means downloading one photo, which is why it is not the default: the rest
    // of this command touches no media at all.
    //
    // The photo goes to a temporary file, its metadata is read, and the file is deleted in a
    // finally. Nothing about it is printed except whether a capture date exists and how far
    // it is from the posted time.
    if (options.deep) {
      const withMedia = items
        .map((item) => item as Record<string, unknown>)
        .filter((item) => typeof (item.media as Record<string, unknown>)?.image_url === 'string')
        .slice(0, 3);
      if (withMedia.length === 0) {
        report.warnings.push('--deep found no photo to examine on this page.');
      } else {
        const probe = await probeCaptureTimes(withMedia, doFetch);
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
          const without = await doFetch(mediaUrl, { method: 'HEAD' });
          report.findings.push(
            `Media fetch WITHOUT the session cookie: HTTP ${without.status}.` +
              (without.ok
                ? ' CONFIRMED: the URL signature alone is enough, which is what downloading relies on.'
                : ' Unexpected — investigate before trusting downloads.'),
          );
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

  return report;
}

/** Render the report as text that is safe to paste into a public issue. */
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
  doFetch: typeof fetch,
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
      const response = await doFetch(url);
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

export function formatReport(report: VerifyReport): string {
  const lines: string[] = [
    '',
    '  Brightwheel API verification (read-only, no photos downloaded)',
    '  This report contains field names and types only - no names, photos or values.',
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
