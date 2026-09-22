import { DEFAULT_BASE_URL, SESSION_COOKIE } from './api/client.js';
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
