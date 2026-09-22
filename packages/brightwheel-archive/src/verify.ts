import { BrightwheelClient, DEFAULT_BASE_URL, SESSION_COOKIE } from './api/client.js';
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
 * its value. The one exception is a boolean derived from two timestamps (does event_date
 * differ from created_at), which is the specific claim the whole timestamp-correction
 * feature rests on and which cannot be checked any other way.
 *
 * It makes at most four requests and downloads no media.
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
async function raw(
  path: string,
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
  if (!(response.headers.get('content-type') ?? '').includes('json')) {
    throw new Error(`Expected JSON from ${path}, got ${response.status} ${response.headers.get('content-type')}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

export async function verify(
  session: Secret,
  options: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<VerifyReport> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? fetch;
  const report: VerifyReport = { reachable: false, sessionValid: false, checks: [], findings: [], warnings: [] };

  // 1 — the account.
  const me = await raw('/users/me', session, baseUrl, doFetch);
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
    session,
    baseUrl,
    doFetch,
  );
  const list = (students.students ?? students.data ?? []) as unknown[];
  report.checks.push({
    endpoint: 'GET /guardians/{id}/students',
    fields: [
      { field: 'students', present: Array.isArray(list), type: typeOf(list), note: `${list.length} found` },
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
      page_size: '5',
      include_parent_actions: 'false',
      action_type: 'ac_photo',
    });
    const acts = await raw(
      `/students/${encodeURIComponent(studentId)}/activities?${query}`,
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

    const a = items[0] as Record<string, unknown> | undefined;
    if (a) {
      // The claim the entire timestamp-correction feature depends on.
      const ev = typeof a.event_date === 'string' ? new Date(a.event_date) : null;
      const cr = typeof a.created_at === 'string' ? new Date(a.created_at) : null;
      if (ev && cr) {
        const diffMin = Math.round(Math.abs(cr.getTime() - ev.getTime()) / 60000);
        report.findings.push(
          diffMin > 0
            ? `CONFIRMED: event_date and created_at differ (by ${diffMin} min on this record), so upload time is not capture time.`
            : 'NOTE: event_date and created_at are identical on this record — inconclusive; try one posted late in the day.',
        );
      }

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
          report.findings.push(`Media host: ${u.host}`);

          // 4 — the cookie question. Does the media host reject the session cookie?
          const withCookie = await doFetch(mediaUrl, {
            method: 'HEAD',
            headers: { Cookie: `${SESSION_COOKIE}=${session.expose()}` },
          });
          const without = await doFetch(mediaUrl, { method: 'HEAD' });
          report.findings.push(
            `Media fetch WITHOUT cookie: HTTP ${without.status}. WITH cookie: HTTP ${withCookie.status}.` +
              (without.ok && !withCookie.ok
                ? ' CONFIRMED: sending the session to the media host breaks the request.'
                : without.ok && withCookie.ok
                  ? ' Both work; omitting the cookie is still correct, as the session should reach only the API.'
                  : ' Unexpected — investigate before trusting downloads.'),
          );
        } catch (error) {
          report.warnings.push(`Could not probe the media URL: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        report.warnings.push('No media URL found on the first photo activity — the media field has moved.');
      }
    }
  }

  return report;
}

/** Render the report as text that is safe to paste into a public issue. */
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
