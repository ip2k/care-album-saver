import { loopbackOrigin } from '../ferry/url.js';
import { BodyTooLargeError, readBodyText } from '../http-body.js';
import { Secret, scrub } from '../secrets.js';
import { browserUserAgent } from './identity.js';
import {
  ApiShapeError,
  assertJsonResponse,
  describeContentType,
  parseActivities,
  parseMe,
  parseStudents,
  validateExtraction,
  type MediaActivity,
  type Student,
} from './schema.js';

export const DEFAULT_BASE_URL = 'https://schools.mybrightwheel.com/api/v1';
export const SESSION_COOKIE = '_brightwheel_v2';

export interface ClientOptions {
  session: Secret;
  baseUrl?: string;
  /** Milliseconds to wait between requests. Politeness, not rate-limit evasion. */
  delayMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * The browser identity to send: the one the session was pasted from, when the setup page
   * saw it. Absent or null means a stock desktop Chrome. See api/identity.ts for why the
   * tool never sends a name of its own.
   */
  userAgent?: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How many times a failed request is tried again. A rejected session never is. */
const MAX_RETRIES = 4;

/**
 * The longest `Retry-After` a run will sit through: five minutes (security review
 * outbound-2).
 *
 * The header used to be obeyed as sent, so one 429 asking for a day parked the run for a
 * day — holding the archive's run lock, and with the page showing a bar that had stopped
 * moving. Five minutes is well past the minute or two a busy service asks for, and it keeps
 * one request's retries (four waits at most) near twenty minutes. What that bounds is how
 * long a parent watches a run that is only waiting; the run lock needs no such bound, as it
 * keeps itself fresh on a timer however long a request waits (run-lock.ts). A longer ask is
 * not sat out: the run ends and says why, and the next one — the next day's, or the parent
 * pressing the button later — carries on from where it stopped, exactly as after any other
 * failure part-way.
 */
export const MAX_RETRY_AFTER_SECONDS = 5 * 60;

/**
 * The most of one answer this client will read: 16 MB (security review outbound-7).
 *
 * A page of a hundred posts is JSON measured in kilobytes, a few hundred at most, so this
 * is far past any honest answer while still bounding what a broken or hostile one can make
 * a parent's computer hold in memory. See http-body.ts.
 */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * The most a `Retry-After` is read as: a year. Anything longer asks for the same thing — not
 * this run — and a header of three hundred digits used to reach the sentence that ends a run
 * as "wait Infinity days". It is capped where it is read, so no later arithmetic or message
 * ever meets the raw number.
 */
const RETRY_AFTER_CEILING_SECONDS = 365 * 86_400;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The instant an IMF-fixdate names, in milliseconds, or null when `text` is not one.
 *
 * `Sun, 06 Nov 1994 08:49:37 GMT` and nothing looser: RFC 9110's preferred form, the one every
 * current server sends. `Date.parse` is no judge of that — V8 reads "soon 1" as a date — so the
 * shape is matched exactly and the fields are checked to name a real moment (no 31 February).
 * The two obsolete HTTP-date forms (RFC 850, asctime) are deliberately not read: RFC 9110 asks
 * recipients to accept them, but a server that sends one only loses its own wait, not
 * correctness — the header then reads as absent and the client's own backoff applies.
 */
function imfFixdate(text: string): number | null {
  const m = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(text);
  if (!m) return null;
  const [day, month, year, hour, minute, second] = [Number(m[1]), MONTHS.indexOf(m[2]!), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  if (month < 0 || hour > 23 || minute > 59 || second > 60) return null;
  const at = Date.UTC(year, month, day, hour, minute, Math.min(second, 59));
  // A day the month does not have rolls over into the next, and Date.UTC reads years 0–99 as
  // 1900–1999; neither is the date that was sent.
  const read = new Date(at);
  return read.getUTCDate() === day && read.getUTCFullYear() === year ? at : null;
}

/**
 * How many seconds a `Retry-After` header asks for, or null when there is none it can read.
 *
 * Both forms the standard allows: a whole number of seconds, or an HTTP date — read only as
 * an IMF-fixdate (see `imfFixdate`), since `Date.parse` makes a date out of nearly anything.
 * A date in the past asks for no wait at all. Either form is capped at
 * RETRY_AFTER_CEILING_SECONDS, which says the same to the caller as any larger number would.
 */
export function retryAfterSeconds(header: string | null, now: number = Date.now()): number | null {
  const text = header?.trim() ?? '';
  // More digits than any ceiling needs is the ceiling; `Number()` of hundreds is Infinity.
  if (/^\d+$/.test(text)) return text.length > 10 ? RETRY_AFTER_CEILING_SECONDS : Math.min(Number(text), RETRY_AFTER_CEILING_SECONDS);
  const at = imfFixdate(text);
  return at === null ? null : Math.min(RETRY_AFTER_CEILING_SECONDS, Math.max(0, Math.ceil((at - now) / 1000)));
}

/** "2 hours", "90 minutes": how long a wait was asked for, for the sentence that ends a run. */
function describeWait(seconds: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (seconds < 2 * 60 * 60) return plural(Math.ceil(seconds / 60), 'minute');
  if (seconds < 2 * 24 * 60 * 60) return plural(Math.round(seconds / 3600), 'hour');
  if (seconds < RETRY_AFTER_CEILING_SECONDS) return plural(Math.round(seconds / 86_400), 'day');
  return 'a year or more';
}

/**
 * An answer that asking again within this run cannot improve, so the retry loop hands it
 * straight up instead of spending four more requests on it.
 *
 * Deliberately still an ApiShapeError by name: `sync` ends the run on that name rather than
 * counting it against one photo and moving on to the next, and moving on is exactly what
 * must not happen here — each following photo would ask again, for an answer already known
 * to be no use, or of a Brightwheel that has asked to be left alone.
 */
export class NotThisRunError extends ApiShapeError {}

/** Posts per listing request. Brightwheel may return fewer; it never returns more. */
const DEFAULT_PAGE_SIZE = 100;

/**
 * How far an incremental walk keeps going after the feed appears to be older than the
 * cut-off: this many pages in a row must be entirely older before it stops.
 *
 * One page is not enough, because the feed is ordered by *upload* time while the cut-off is
 * a post's `event_date`, and on an account whose teachers back-date, `event_date` can be
 * older than the feed order suggests. A batch posted this morning but dated last week would
 * sit at the very top of the feed with dates older than anything the last run saw. Stopping
 * at that first page would end the walk on the batch and never reach the genuinely new
 * posts underneath it — and because a walk that saw nothing new does not move the cut-off
 * either, no later run would reach them, while the tool reported that everything was up to
 * date. That is a photo lost for good, which is the one failure this project cannot accept.
 * On the one real account checked so far, `event_date` equals `created_at` on every post,
 * so there the slack is insurance rather than a necessity.
 *
 * The trade is requests against photos. Each extra page is one more API request and one more
 * politeness delay on every nightly run; three pages is roughly 300 posts at the default
 * page size, which is larger than any plausible single back-dated batch and costs about a
 * second. A larger number buys tolerance for a bigger batch at the same linear cost; a
 * smaller one saves a request and silently loses photos.
 */
export const PAGES_PAST_THE_CUT_OFF = 3;

export interface ActivityListOptions {
  pageSize?: number;
  /**
   * Hard stop on how many pages one walk reads. A runaway loop against a parent's account
   * is worse than an unfinished walk, so the limit stays — but reaching it is reported on
   * the last page's `truncated`, because such a walk has not seen the end of the feed.
   */
  maxPages?: number;
  stopBefore?: Date;
  /**
   * Server-side filter, e.g. 'ac_photo'. Brightwheel's feed carries check-ins, naps,
   * meals and notes as well as media; filtering at the server means we do not page
   * through — or parse — thousands of records we would only throw away.
   */
  actionType?: string;
  /** Server-side date window. Turns an incremental run into one short request. */
  since?: Date;
  until?: Date;
}

/**
 * One page of a student's feed, with enough context to ask for exactly this page again.
 *
 * The counts are posts of every kind — check-ins and naps as well as photos — because
 * that is what the envelope counts and what the feed pages through. They are honest
 * measures of how far a walk has got; they are not a photo count.
 */
export interface ActivityPage {
  /** Zero-based page index, as sent in the request. */
  page: number;
  /** The media posts on this page, after client-side filtering. */
  items: MediaActivity[];
  /** Posts of every kind on the whole feed, per the envelope's `count`. Null if absent. */
  posts: number | null;
  /** Posts of every kind on this page, before filtering. Zero means the feed has ended. */
  found: number;
  /** Posts of every kind on this and every earlier page: how far through the feed we are. */
  examined: number;
  /**
   * Set on the last page of a walk that ran into `maxPages` while the feed went on.
   *
   * Without it, a walk cut short by the page limit ends exactly like a walk that reached
   * the end of the feed, and a caller that advances a cut-off at the end of a walk would
   * step over every post it never looked at. Only the walk sets this; a single-page fetch
   * says nothing about where the feed ends.
   */
  truncated?: boolean;
}

/**
 * The envelope fields we read for progress, leniently. These are informational: an odd
 * shape here must never fail a run that the strict parser in schema.ts was happy with.
 */
function readEnvelope(raw: unknown, page: number, pageSize: number, items: number) {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const list = o.activities ?? o.data ?? o.object;
  const found = Array.isArray(list) ? list.length : items;
  const offset = num(o.offset) ?? page * (num(o.page_size) ?? pageSize);
  return { posts: num(o.count), found, examined: offset + found };
}

/**
 * A thin, deliberately boring client for Brightwheel's internal API.
 *
 * Politeness policy: one request at a time, a small delay between them, and exponential
 * backoff that honours `Retry-After` — up to MAX_RETRY_AFTER_SECONDS, past which the run
 * stops rather than wait. This tool runs unattended in the background on
 * someone's home machine against a service used by childcare centres. Being a heavy client
 * would risk the account of the person running it, so the defaults are conservative and
 * the concurrency is one.
 */
export class BrightwheelClient {
  private readonly baseUrl: string;
  private readonly delayMs: number;
  private readonly doFetch: typeof fetch;
  private readonly userAgent: string;
  /**
   * The API's own origin when that is this computer, else null: the one place media may come
   * from without being https and public (`mediaUrlRefusal` in ferry/url.ts). The default
   * address is Brightwheel's, so for every normal install this is null; it is set for the
   * mock server, the demo and the tests, which serve their pictures from where they answer.
   */
  private readonly trustedMediaOrigin: string | null;
  private lastRequest = 0;

  constructor(private readonly options: ClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.delayMs = options.delayMs ?? 400;
    this.doFetch = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent || browserUserAgent();
    this.trustedMediaOrigin = loopbackOrigin(this.baseUrl);
  }

  /** Headers for an API call. The session cookie is exposed only here. */
  private headers(): Record<string, string> {
    return {
      Cookie: `${SESSION_COOKIE}=${this.options.session.expose()}`,
      Accept: 'application/json',
      // The web client identifies itself as 'web'; an unrecognised value risks rejection.
      'X-Client-Name': 'web',
      'User-Agent': this.userAgent,
    };
  }

  /**
   * Headers for fetching a media file.
   *
   * Deliberately WITHOUT the session cookie. Media lives on a CDN behind presigned URLs,
   * and sending the Brightwheel cookie to it is actively harmful: the CDN rejects the
   * request with a permission error. The URL's own signature is the authorisation.
   *
   * It is also the safer default — the session is an account-takeover credential, so it
   * should reach exactly one origin (the API) and no other.
   */
  mediaHeaders(): Record<string, string> {
    // The same identity as the API calls: a browser fetches the pictures it is shown.
    return { 'User-Agent': this.userAgent };
  }

  private async request(path: string, context: string): Promise<unknown> {
    const wait = this.delayMs - (Date.now() - this.lastRequest);
    if (wait > 0) await sleep(wait);

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(30_000, 1000 * 2 ** (attempt - 1));
        await sleep(backoff);
      }
      try {
        const response = await this.doFetch(`${this.baseUrl}${path}`, { headers: this.headers() });
        this.lastRequest = Date.now();

        if (response.status === 429 || response.status >= 500) {
          const asked = retryAfterSeconds(response.headers.get('retry-after'));
          // Nothing in a refusal is read, so let the connection go now rather than at the
          // next garbage collection.
          await response.body?.cancel().catch(() => {});
          if (asked !== null && asked > MAX_RETRY_AFTER_SECONDS) {
            throw new NotThisRunError(
              `Brightwheel asked this tool to wait ${describeWait(asked)} before asking it anything else, ` +
                `which is longer than a run waits, so this run stopped here rather than keep asking. ` +
                `It will ask again at the next run.`,
            );
          }
          lastError = new ApiShapeError(`HTTP ${response.status} from ${context}`);
          // No wait after the last attempt: there is no request left for it to be polite before.
          if (asked && attempt < MAX_RETRIES) await sleep(asked * 1000);
          continue;
        }

        // Every other refusal is final (security review outbound-9). A 404, a 400, a 410 is
        // Brightwheel's considered answer to this request, and it used to be asked again four
        // times over fifteen seconds for the same answer — each one a request against the
        // parent's account. 401 and 403 are left to assertJsonResponse, which reads them as
        // the session being refused. Nothing in the answer is read, so it is let go at once.
        if (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 403) {
          const shown = describeContentType(response.headers.get('content-type'));
          await response.body?.cancel().catch(() => {});
          throw new NotThisRunError(
            `HTTP ${response.status} from ${context} (${shown}). Asking again would only get the same answer, ` +
              `so it was not asked again.`,
          );
        }

        let body: string;
        try {
          body = await readBodyText(response, MAX_RESPONSE_BYTES);
        } catch (error) {
          if (!(error instanceof BodyTooLargeError)) throw error;
          throw new NotThisRunError(
            `Brightwheel's answer for ${context} was larger than ${MAX_RESPONSE_BYTES / (1024 * 1024)} MB, ` +
              `far more than it ever sends, so it was not read. This usually means Brightwheel changed something.`,
          );
        }
        assertJsonResponse(response, body, context);
        try {
          return JSON.parse(body);
        } catch {
          throw new ApiShapeError(`Could not parse JSON from ${context}`);
        }
      } catch (error) {
        // A session error is final — retrying cannot fix it, and hammering the endpoint
        // with an invalid session is exactly how an account gets flagged.
        if (error instanceof Error && error.name === 'SessionExpiredError') throw error;
        if (error instanceof NotThisRunError) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Failed: ${context}`);
  }

  async me(): Promise<{ id: string; email: string | null }> {
    return parseMe(await this.request('/users/me', 'users/me'));
  }

  /**
   * The children on this account.
   *
   * There is no "list all students" call — the path is scoped to the guardian id that the
   * session already resolves to. A parent's session can only ever enumerate their own
   * children. That guarantee is Brightwheel's, enforced server-side; this tool does not
   * and cannot widen it.
   */
  async students(guardianId: string): Promise<Student[]> {
    const raw = await this.request(
      `/guardians/${encodeURIComponent(guardianId)}/students?include[]=schools`,
      'students',
    );
    return parseStudents(raw);
  }

  /**
   * One page of a student's feed.
   *
   * Separate from the walk so that a caller can ask for a page a second time. Signed
   * media URLs come from here and are short-lived; a long run outlives them, and the only
   * way to a fresh signature is the listing that issued the old one.
   */
  async activitiesPage(studentId: string, page: number, opts: ActivityListOptions = {}): Promise<ActivityPage> {
    const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    // start_date / end_date are ISO-8601 UTC with milliseconds and a Z suffix, not a bare
    // calendar date — taken from ChaseBro/brightwheel-takeout and ss44/Keepsake; not yet
    // checked against the live service, which nothing in this tool has sent them to.
    const iso = (d: Date) => d.toISOString().replace(/(\.\d{3})?Z$/, '.000Z');

    const query = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      include_parent_actions: 'false',
    });
    if (opts.actionType) query.set('action_type', opts.actionType);
    if (opts.since) query.set('start_date', iso(opts.since));
    if (opts.until) query.set('end_date', iso(opts.until));
    const raw = await this.request(
      `/students/${encodeURIComponent(studentId)}/activities?${query}`,
      `activities page ${page}`,
    );
    const { items, undated, refused, refusedBecause } = parseActivities(raw, studentId, {
      trustedMediaOrigin: this.trustedMediaOrigin,
    });
    const check = validateExtraction(items, page, undated, refused, refusedBecause);
    if (check.status === 'suspicious') {
      throw new ApiShapeError(check.message);
    }
    return { page, items, ...readEnvelope(raw, page, pageSize, items.length) };
  }

  /**
   * A student's feed, newest first, one page at a time.
   *
   * This is what the website's infinite scroll is actually doing underneath. Reading the
   * paginated endpoint directly means no headless browser, no scroll simulation, and no
   * guessing about when the feed has ended: it has ended when a page carries no posts of
   * any kind. A page of nothing but check-ins is not the end — the photos may be on the
   * next one — so a page can be yielded with no media on it, and a caller reads `found`
   * and `examined` to keep its progress honest.
   */
  async *activityPages(studentId: string, opts: ActivityListOptions = {}): AsyncGenerator<ActivityPage, void, void> {
    const maxPages = opts.maxPages ?? 500;
    /** Consecutive pages, so far, that carried media and nothing newer than the cut-off. */
    let olderPages = 0;

    // The largest page this walk has seen, which is the server's effective page size.
    let biggestPage = 0;
    for (let page = 0; page < maxPages; page++) {
      const result = await this.activitiesPage(studentId, page, opts);
      if (result.found === 0) return;

      // Incremental runs stop once the feed is older than what we already have — but not
      // at the first such page. Only a page with media on it votes at all: a page of
      // check-ins carries no photo dates, so it leaves the tally where it was rather
      // than resetting it and stretching the walk.
      const { items } = result;
      if (opts.stopBefore && items.length > 0) {
        olderPages = items.every((i) => i.postedAt < opts.stopBefore!) ? olderPages + 1 : 0;
      }
      const reachedCutOff = olderPages >= PAGES_PAST_THE_CUT_OFF;

      // Truncated means "the page limit stopped the walk", which is only true if there was
      // more to fetch. Measure that against the largest page this walk has actually seen
      // rather than the page size we asked for: Brightwheel may clamp page_size below the
      // request, and comparing with the request would then call every page short. A last
      // page smaller than the biggest one is the feed ending, which happens to land on the
      // limit — warning about that would tell a parent on every run that their archive may
      // be incomplete when it is not.
      biggestPage = Math.max(biggestPage, result.found);
      const lastAllowedPage = page === maxPages - 1;
      yield { ...result, truncated: !reachedCutOff && lastAllowedPage && result.found >= biggestPage };
      if (reachedCutOff) return;
    }
  }

  /**
   * Every media post for a student, newest first. The page-level walk without the context.
   *
   * Note what is dropped with that context: a caller here cannot tell a walk that reached
   * the end of the feed from one `maxPages` cut short. Anything that records how far it
   * got — `sync` does — must read the pages, not this.
   */
  async *activities(studentId: string, opts: ActivityListOptions = {}): AsyncGenerator<MediaActivity[], void, void> {
    for await (const page of this.activityPages(studentId, opts)) {
      if (page.items.length > 0) yield page.items;
    }
  }

  /**
   * Whether Brightwheel accepts this session. `rejected` separates "Brightwheel said no" from
   * everything else that can go wrong on the way (no network, a changed API), because only
   * the first is fixed by copying the value again — and the caller words it for its reader.
   */
  async verifySession(): Promise<
    { ok: true; email: string | null } | { ok: false; reason: string; rejected: boolean }
  > {
    try {
      const me = await this.me();
      return { ok: true, email: me.email };
    } catch (error) {
      return {
        ok: false,
        reason: failureReason(error),
        rejected: error instanceof Error && error.name === 'SessionExpiredError',
      };
    }
  }
}

/**
 * An error's message with what caused it, for a person to act on (security review
 * outbound-11).
 *
 * Node's fetch reports every failure to connect as the same two words, "fetch failed", and
 * keeps what happened in `cause`: `getaddrinfo ENOTFOUND schools.mybrightwheel.com` (no
 * network, or a name that does not resolve), `connect ECONNREFUSED …`, a certificate the
 * connection did not trust. The two words alone left a parent at the setup page with nothing
 * to try. An AggregateError cause — IPv4 and IPv6 both refused — has an empty message, so its
 * first error speaks for it. Scrubbed on the way out; the callers scrub again, which is free.
 * Exported for its test: the retries in front of it take fifteen seconds to fail for real.
 */
export function failureReason(error: unknown): string {
  if (!(error instanceof Error)) return scrub(String(error));
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return scrub(error.message);
  const c = cause as { code?: unknown; message?: unknown; errors?: unknown };
  const firstOfMany = Array.isArray(c.errors) && c.errors[0] instanceof Error ? c.errors[0].message : '';
  const message = (typeof c.message === 'string' && c.message) || firstOfMany;
  const code = typeof c.code === 'string' ? c.code : '';
  const detail = message && code && !message.includes(code) ? `${code}: ${message}` : message || code;
  return scrub(detail ? `${error.message} (${detail.slice(0, 300)})` : error.message);
}
