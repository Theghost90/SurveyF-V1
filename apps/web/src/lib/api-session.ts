import { API_URL, internalHeaders } from './auth';

/**
 * Renewing the API token from the refresh token, on the website's server (never in the browser).
 *
 * A page makes several API calls at once, and when the token has just run out they would all try to refresh with the same refresh token. Within ONE server
 * process they share a single refresh (below); across processes the API's grace window covers it (a refresh token used a moment after it was rotated gets
 * a new API token and is told to keep its cookie), so neither case looks like theft.
 */
export interface Renewed {
  accessToken: string;
  /** ms since the epoch */
  accessTokenExp: number;
  /** null: another request already rotated it; keep the cookie that holds the newer one. */
  refreshToken: string | null;
  sessionExp: number;
}

/** `ended`: the API says this sign-in is over. `unavailable`: it could not be asked (restart, network, too slow): the cookie must be KEPT, the visitor did nothing wrong. */
export type RenewResult = Renewed | 'ended' | 'unavailable';

const inflight = new Map<string, Promise<RenewResult>>();
const CALL_TIMEOUT_MS = 15_000;

async function call(refreshToken: string, forwarded: Record<string, string>): Promise<RenewResult> {
  try {
    const res = await fetch(`${API_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...internalHeaders(), ...forwarded },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS), // a hung API must not leave every later request of this session waiting on the same promise
    });
    if (res.status === 401 || res.status === 400) return 'ended'; // ended, expired, or the token was replayed
    if (!res.ok) return 'unavailable';
    const b = (await res.json()) as { accessToken: string; accessTokenExpiresAt: string; refreshToken: string | null; sessionExpiresAt: string };
    return { accessToken: b.accessToken, accessTokenExp: Date.parse(b.accessTokenExpiresAt), refreshToken: b.refreshToken, sessionExp: Date.parse(b.sessionExpiresAt) };
  } catch {
    return 'unavailable';
  }
}

/**
 * One refresh per refresh token at a time in this process; late arrivals within a few seconds get the same answer. The key is the refresh token itself, not
 * only the session: a request that carries an OLDER copy of the cookie (the sign of a stolen one) must not be handed the legitimate owner's new tokens.
 */
export function renewApiToken(sessionId: string, refreshToken: string, forwarded: Record<string, string> = {}): Promise<RenewResult> {
  const key = `${sessionId}:${refreshToken}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = call(refreshToken, forwarded);
  inflight.set(key, p);
  void p.then((r) => {
    // A failure is not worth remembering (the next request should try again); an answer is kept a moment so that requests arriving right after share it.
    if (r === 'unavailable') inflight.delete(key);
    else setTimeout(() => inflight.delete(key), 3000).unref?.();
  });
  return p;
}
