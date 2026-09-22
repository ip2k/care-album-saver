import { Secret } from '../secrets.js';
import {
  ApiShapeError,
  assertJsonResponse,
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
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  onLog?: (message: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A thin, deliberately boring client for Brightwheel's internal API.
 *
 * Politeness policy: one request at a time, a small delay between them, and exponential
 * backoff that honours `Retry-After`. This tool runs unattended in the background on
 * someone's home machine against a service used by childcare centres. Being a heavy client
 * would risk the account of the person running it, so the defaults are conservative and
 * the concurrency is one.
 */
export class BrightwheelClient {
  private readonly baseUrl: string;
  private readonly delayMs: number;
  private readonly maxRetries: number;
  private readonly doFetch: typeof fetch;
  private readonly log: (m: string) => void;
  private lastRequest = 0;

  constructor(private readonly options: ClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.delayMs = options.delayMs ?? 400;
    this.maxRetries = options.maxRetries ?? 4;
    this.doFetch = options.fetchImpl ?? fetch;
    this.log = options.onLog ?? (() => {});
  }

  /** Headers for an API call. The session cookie is exposed only here. */
  private headers(): Record<string, string> {
    return {
      Cookie: `${SESSION_COOKIE}=${this.options.session.expose()}`,
      Accept: 'application/json',
      // The web client identifies itself as 'web'; an unrecognised value risks rejection.
      'X-Client-Name': 'web',
      'User-Agent': 'brightwheel-archive (+https://github.com/)',
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
    return { 'User-Agent': 'brightwheel-archive (+https://github.com/)' };
  }

  private async request(path: string, context: string): Promise<unknown> {
    const wait = this.delayMs - (Date.now() - this.lastRequest);
    if (wait > 0) await sleep(wait);

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(30_000, 1000 * 2 ** (attempt - 1));
        this.log(`Retrying ${context} in ${Math.round(backoff / 1000)}s (attempt ${attempt + 1})`);
        await sleep(backoff);
      }
      try {
        const response = await this.doFetch(`${this.baseUrl}${path}`, { headers: this.headers() });
        this.lastRequest = Date.now();

        if (response.status === 429 || response.status >= 500) {
          const retryAfter = Number(response.headers.get('retry-after'));
          if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(retryAfter * 1000);
          lastError = new ApiShapeError(`HTTP ${response.status} from ${context}`, context);
          continue;
        }

        const body = await response.text();
        assertJsonResponse(response, body, context);
        try {
          return JSON.parse(body);
        } catch {
          throw new ApiShapeError(`Could not parse JSON from ${context}`, context);
        }
      } catch (error) {
        // A session error is final — retrying cannot fix it, and hammering the endpoint
        // with an invalid session is exactly how an account gets flagged.
        if (error instanceof Error && error.name === 'SessionExpiredError') throw error;
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
   * Every media post for a student, newest first, walking the paginated feed.
   *
   * This is what the website's infinite scroll is actually doing underneath. Reading the
   * paginated endpoint directly means no headless browser, no scroll simulation, and no
   * guessing about when the feed has ended.
   */
  async *activities(
    studentId: string,
    opts: {
      pageSize?: number;
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
    } = {},
  ): AsyncGenerator<MediaActivity[], void, void> {
    const pageSize = opts.pageSize ?? 100;
    const maxPages = opts.maxPages ?? 500;
    // start_date / end_date are ISO-8601 UTC with milliseconds and a Z suffix, not a bare
    // calendar date — confirmed across ChaseBro/brightwheel-takeout and ss44/Keepsake.
    const iso = (d: Date) => d.toISOString().replace(/(\.\d{3})?Z$/, '.000Z');

    for (let page = 0; page < maxPages; page++) {
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
      const items = parseActivities(raw, studentId);
      const check = validateExtraction(items, page);
      this.log(`Page ${page}: ${check.message}`);

      if (check.status === 'suspicious') {
        throw new ApiShapeError(check.message, `activities page ${page}`);
      }
      if (items.length === 0) return;

      yield items;

      // Incremental runs stop once the feed is older than what we already have.
      if (opts.stopBefore && items.every((i) => i.capturedAt < opts.stopBefore!)) return;
    }
  }

  /** Cheap liveness check used by `login` and `doctor`. */
  async verifySession(): Promise<{ ok: true; email: string | null } | { ok: false; reason: string }> {
    try {
      const me = await this.me();
      return { ok: true, email: me.email };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

export type { MediaActivity, Student };
