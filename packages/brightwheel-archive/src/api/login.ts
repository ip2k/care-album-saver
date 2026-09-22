import { Secret } from '../secrets.js';
import { ApiShapeError } from './schema.js';
import { DEFAULT_BASE_URL, SESSION_COOKIE } from './client.js';

/**
 * Optional: sign in directly, with email, password and the 2FA code.
 *
 * THIS IS NOT THE DEFAULT, on purpose.
 *
 * The default flow asks the parent to paste a session value copied from their browser,
 * because that way this software never touches their Brightwheel password. Teaching people
 * to type real credentials into third-party tools is the habit phishing depends on, and a
 * tool aimed at non-technical parents should not be the one teaching it.
 *
 * But the DevTools step is genuinely hard for the audience, and Brightwheel does expose a
 * normal two-step login, so this exists for people who knowingly choose it:
 *
 *   POST /sessions/start  { user: { email, password } }
 *     -> { 2fa_required: true, 2fa_code_sent_to: [...] }  and Brightwheel sends the code
 *   POST /sessions        { user: { email, password, 2fa_code } }
 *     -> { csrf: "..." } and a Set-Cookie carrying the session
 *
 * The password is held only for the seconds between the two calls, is wrapped in `Secret`
 * so it cannot be logged, and is never written to disk. Only the resulting session is
 * persisted.
 */

export interface LoginStart {
  /** Where Brightwheel says it sent the code, e.g. ["e****@example.com"]. */
  codeSentTo: string[];
  twoFactorRequired: boolean;
}

export interface LoginOptions {
  email: string;
  password: Secret;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

function loginHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Client-Name': 'brightwheel-archive',
    'User-Agent': 'brightwheel-archive (+https://github.com/)',
  };
}

/** Extract the session cookie from a Set-Cookie response header. */
function readSessionCookie(response: Response): Secret | null {
  // getSetCookie() returns every Set-Cookie separately; a plain get() would join them
  // and lose values whose own content contains a comma.
  const headers =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? ''];
  for (const header of headers) {
    const match = header.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
    if (match?.[1]) return new Secret(decodeURIComponent(match[1]));
  }
  return null;
}

/**
 * Step one: hand over email and password so Brightwheel sends a 6-digit code.
 * Returns where the code was sent, so the UI can say "check your email" precisely.
 */
export async function startLogin(options: LoginOptions): Promise<LoginStart> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

  const response = await doFetch(`${base}/sessions/start`, {
    method: 'POST',
    headers: loginHeaders(),
    body: JSON.stringify({
      user: { email: options.email, password: options.password.expose() },
    }),
  });

  if (response.status === 401 || response.status === 422) {
    throw new LoginError('That email address and password did not work. Please check both and try again.');
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    throw new ApiShapeError('Brightwheel did not answer the sign-in request in the expected way.', 'sessions/start');
  }

  const body = (await response.json()) as Record<string, unknown>;
  return {
    twoFactorRequired: body['2fa_required'] !== false,
    codeSentTo: Array.isArray(body['2fa_code_sent_to'])
      ? (body['2fa_code_sent_to'] as unknown[]).map(String)
      : [],
  };
}

/**
 * Step two: submit the 6-digit code and receive the session.
 * The password is required again because Brightwheel's endpoint expects the full user
 * object; it is still never stored.
 */
export async function completeLogin(
  options: LoginOptions & { code: string },
): Promise<{ session: Secret; csrf: string | null }> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

  const code = options.code.trim().replace(/\s+/g, '');
  if (!/^\d{4,8}$/.test(code)) {
    throw new LoginError('That code should be the 6 digits Brightwheel just sent you.');
  }

  const response = await doFetch(`${base}/sessions`, {
    method: 'POST',
    headers: loginHeaders(),
    body: JSON.stringify({
      user: { email: options.email, password: options.password.expose(), '2fa_code': code },
    }),
  });

  if (response.status === 401 || response.status === 422) {
    throw new LoginError('That code was not accepted. Codes expire quickly — request a new one and try again.');
  }

  const session = readSessionCookie(response);
  if (!session) {
    throw new ApiShapeError('Brightwheel accepted the code but did not return a session.', 'sessions');
  }

  let csrf: string | null = null;
  try {
    const body = (await response.json()) as Record<string, unknown>;
    csrf = typeof body.csrf === 'string' ? body.csrf : null;
  } catch {
    // The cookie is what matters; the CSRF token is a bonus.
  }
  return { session, csrf };
}

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginError';
  }
}
