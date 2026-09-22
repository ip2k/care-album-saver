import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BrightwheelClient } from '../api/client.js';
import type { Student } from '../api/schema.js';
import { loadConfig, loadSession, normaliseCookieInput, saveConfig, saveSession, type Config } from '../config.js';
import { Secret, scrub } from '../secrets.js';
import { sync, type SyncProgress } from '../sync.js';
import { checkArchiveDir } from '../safety.js';
import { PAGE } from './page.js';

/**
 * The local setup assistant.
 *
 * Runs on the parent's own machine and is reachable only from that machine. Four controls
 * make that true, and each one blocks a real attack:
 *
 *  1. Bound to 127.0.0.1, never 0.0.0.0. On 0.0.0.0 the UI would be reachable by anyone on
 *     the same cafe or hotel wifi.
 *
 *  2. The Host header is checked against an allowlist. Without this, a hostile website can
 *     point a domain it controls at 127.0.0.1 (DNS rebinding) and then read this UI's
 *     responses from the victim's browser, because to the browser it is same-origin.
 *
 *  3. Cross-site requests are rejected via Sec-Fetch-Site and Origin. A page the parent is
 *     merely visiting can otherwise POST to http://127.0.0.1:PORT in the background.
 *
 *  4. Every request carries a one-time token printed by the CLI. Other local accounts and
 *     other processes on a shared computer cannot reach the UI without it.
 */

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostAllowed(header: string | undefined): boolean {
  if (!header) return false;
  const host = header.replace(/:\d+$/, '');
  return ALLOWED_HOSTS.has(host);
}

function crossSite(req: IncomingMessage): boolean {
  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') return true;
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    try {
      if (!hostAllowed(new URL(origin).host)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface WebUiOptions {
  port?: number;
  baseUrl?: string;
  openBrowser?: boolean;
}

export interface WebUiHandle {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
}

export async function startWebUi(options: WebUiOptions = {}): Promise<WebUiHandle> {
  const token = randomBytes(24).toString('base64url');
  let progress: SyncProgress = { phase: 'starting', message: 'Ready', saved: 0, skipped: 0, failed: 0 };
  let running = false;
  let lastResult: unknown = null;
  // The children on the account, as last read from Brightwheel. Kept so that choosing a
  // child in the page does not cost a round trip to Brightwheel per tick, and so that
  // "every child is ticked" can be recognised and stored as "all" (an empty list), which
  // is what keeps a child added to the account later from being silently left out.
  let children: Student[] | null = null;
  // Settings now save themselves as each control changes, so two quick ticks can arrive
  // together. Each save is a read-modify-write of one file; run them one at a time or the
  // second read can miss the first write and quietly undo it.
  let configWrites: Promise<void> = Promise.resolve();

  const withConfigLock = <T>(work: () => Promise<T>): Promise<T> => {
    const result = configWrites.then(work);
    // A refused save must not jam the queue for the saves after it.
    configWrites = result.then(() => {}, () => {});
    return result;
  };

  const readChildren = async (client: BrightwheelClient): Promise<Student[]> => {
    if (!children) {
      const me = await client.me();
      children = await client.students(me.id);
    }
    return children;
  };

  /** Which of the account's children the config selects. Empty config means all of them. */
  const includedIds = (config: Config, list: Student[]): string[] =>
    config.includeStudents.length === 0
      ? list.map((s) => s.id)
      : list.filter((s) => config.includeStudents.includes(s.id)).map((s) => s.id);

  /**
   * Check a child selection before it is stored.
   *
   * The page sends the ids that are ticked, never the empty-means-all shorthand, so that
   * "nothing ticked" is expressible and can be refused here rather than turning into a
   * confusing "no children found" the first time a run starts.
   */
  const checkIncludeStudents = async (
    value: unknown,
  ): Promise<{ ok: true; resolved: string[] } | { ok: false; error: string }> => {
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.length > 0)) {
      return { ok: false, error: 'Could not read which children were chosen. Reload the page and try again.' };
    }
    const chosen = [...new Set(value as string[])];
    if (chosen.length === 0) {
      return { ok: false, error: 'Tick at least one child. Photos are only saved for the children you tick.' };
    }
    const session = await loadSession();
    if (!session) return { ok: true, resolved: chosen };
    const known = await readChildren(new BrightwheelClient({ session: session.session, baseUrl: options.baseUrl }));
    const knownIds = new Set(known.map((s) => s.id));
    if (chosen.some((id) => !knownIds.has(id))) {
      return {
        ok: false,
        error: 'One of the chosen children is no longer on this Brightwheel account. Reload the page and choose again.',
      };
    }
    return { ok: true, resolved: known.every((s) => chosen.includes(s.id)) ? [] : chosen };
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Nothing here may ever be cached: the pages list children's names and photos.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
    );

    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Blocked: unexpected Host header. This page is only reachable from this computer.');
      return;
    }
    if (crossSite(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Blocked: cross-site request.');
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1`);
    const provided = url.searchParams.get('token') ?? (req.headers['x-setup-token'] as string) ?? '';
    if (!tokenMatches(provided, token)) {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<h1>Wrong or missing setup link</h1><p>Use the exact link printed in your terminal.</p>');
      return;
    }

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE.replace(/__TOKEN__/g, token));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const config = await loadConfig();
        const session = await loadSession();
        json(200, {
          hasSession: Boolean(session),
          sessionFingerprint: session?.session.fingerprint() ?? null,
          sessionSavedAt: session?.savedAt.toISOString() ?? null,
          email: session?.email ?? null,
          config,
          progress,
          running,
          lastResult,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/session') {
        const { cookie } = JSON.parse(await readBody(req)) as { cookie?: string };
        const secret = cookie ? normaliseCookieInput(cookie) : null;
        if (!secret) {
          json(400, { ok: false, error: "That does not look like a Brightwheel session. Look for the value named _brightwheel_v2." });
          return;
        }
        const client = new BrightwheelClient({ session: secret, baseUrl: options.baseUrl });
        const check = await client.verifySession();
        if (!check.ok) {
          json(400, { ok: false, error: scrub(check.reason) });
          return;
        }
        await saveSession(secret, check.email);
        // A different account has different children.
        children = null;
        json(200, { ok: true, email: check.email, fingerprint: secret.fingerprint() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/config') {
        const patch = JSON.parse(await readBody(req)) as Partial<Config>;
        // Never persist a destination without checking it. This endpoint previously
        // accepted any path at all and the tool wrote a child's photos there.
        let warning: string | undefined;
        if (typeof patch.archiveDir === 'string') {
          const verdict = checkArchiveDir(patch.archiveDir);
          if (!verdict.ok) {
            json(400, { ok: false, error: verdict.error, field: 'archiveDir' });
            return;
          }
          patch.archiveDir = verdict.resolved;
          warning = verdict.warning;
        }
        if (patch.includeStudents !== undefined) {
          const verdict = await checkIncludeStudents(patch.includeStudents);
          if (!verdict.ok) {
            json(400, { ok: false, error: verdict.error, field: 'includeStudents' });
            return;
          }
          patch.includeStudents = verdict.resolved;
        }
        const config = await withConfigLock(async () => {
          const merged = { ...(await loadConfig()), ...patch };
          await saveConfig(merged);
          return merged;
        });
        json(200, { ok: true, config, warning });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/children') {
        const session = await loadSession();
        if (!session) {
          json(400, { ok: false, error: 'Not signed in yet.' });
          return;
        }
        const client = new BrightwheelClient({ session: session.session, baseUrl: options.baseUrl });
        const me = await client.me();
        // Always re-read here rather than serving the cache: this is the call the page
        // makes on load, and a child added to the account since should appear.
        children = await client.students(me.id);
        json(200, { ok: true, children, included: includedIds(await loadConfig(), children) });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/sync') {
        if (running) {
          json(409, { ok: false, error: 'Already running.' });
          return;
        }
        const session = await loadSession();
        if (!session) {
          json(400, { ok: false, error: 'Not signed in yet.' });
          return;
        }
        running = true;
        lastResult = null;
        const config = await loadConfig();
        const client = new BrightwheelClient({
          session: session.session,
          baseUrl: options.baseUrl,
          delayMs: config.delayMs,
        });
        json(202, { ok: true });
        sync(client, config, (p) => {
          progress = p;
        })
          .then((r) => {
            lastResult = r;
            running = false;
          })
          .catch((e: unknown) => {
            progress = {
              phase: 'error',
              message: scrub(e instanceof Error ? e.message : String(e)),
              saved: progress.saved,
              skipped: progress.skipped,
              failed: progress.failed,
            };
            running = false;
          });
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    } catch (error) {
      json(500, { ok: false, error: scrub(error instanceof Error ? error.message : String(error)) });
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
