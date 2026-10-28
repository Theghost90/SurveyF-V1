import { signOut } from 'next-auth/react';
import type { TFn, TKey } from './i18n';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, any>, public issues?: Array<{ path: string; message: string }>) {
    super(message);
  }
}

let stepUpHandler: ((methods: string[]) => Promise<boolean>) | null = null;
/** The "confirm it is you" dialog registers itself here (components/step-up-dialog.tsx), so any call can ask for it without knowing about it. */
export function setStepUpHandler(fn: typeof stepUpHandler) { stepUpHandler = fn; }

/**
 * Some calls (a large download, deleting many contacts) are answered "confirm it is you first". Ask the owner once, then repeat the call: the screen that
 * made it never has to know.
 */
async function withStepUp<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'step_up_required' && stepUpHandler) {
      const methods = Array.isArray(err.details?.methods) ? (err.details!.methods as string[]) : ['password'];
      if (await stepUpHandler(methods)) return run();
    }
    throw err;
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown; form?: FormData; signal?: AbortSignal }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/proxy${path}`, {
      method: init.method ?? (init.body !== undefined || init.form ? 'POST' : 'GET'),
      headers: init.form ? undefined : init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
      signal: init.signal,
      cache: 'no-store',
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'network');
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  let data: any = null;
  if (ct.includes('json')) {
    try { data = await res.json(); }
    // A SUCCESS whose body cannot be read (cut off mid-transfer, dropped connection) is a network failure, never `{}`:
    // callers and SWR caches would otherwise treat an empty object as a real answer and crash on `account.user.x`.
    catch { if (res.ok) throw new ApiError(0, 'network', 'network'); data = {}; }
  }
  // "unauthorized" is the one 401 that means the sign-in is over (the proxy and the API both say it that way). Other 401s are answers: a wrong password, a wrong code.
  if (res.status === 401 && data?.error === 'unauthorized') {
    void signOut({ callbackUrl: '/login?expired=1' });
    throw new ApiError(401, 'unauthorized', 'unauthorized');
  }
  if (!res.ok) {
    // One screen answers every "connect your WhatsApp number first" refusal, wherever it came from (see components/whatsapp-gate.tsx).
    if (data?.error === 'whatsapp_not_connected' && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(WHATSAPP_REQUIRED_EVENT));
    if (data?.error === 'two_factor_required' && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(TWO_FACTOR_REQUIRED_EVENT));
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? res.statusText, data?.details, data?.issues);
  }
  return (data ?? undefined) as T;
}

/** Browser → Next proxy (/proxy/*) → API. The proxy attaches the bearer token server-side, so it never reaches page JS. */
export function api<T = any>(path: string, init: { method?: string; body?: unknown; form?: FormData; signal?: AbortSignal } = {}): Promise<T> {
  return withStepUp(() => request<T>(path, init));
}

export const WHATSAPP_REQUIRED_EVENT = 'sf:whatsapp-required';
export const TWO_FACTOR_REQUIRED_EVENT = 'sf:two-factor-required';

/** Downloads a binary export through the proxy (keeps the filename the API chose). */
export function download(path: string, fallbackName: string) {
  return withStepUp(async () => {
    const res = await fetch(`/proxy${path}`, { cache: 'no-store' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data?.error === 'unauthorized') void signOut({ callbackUrl: '/login?expired=1' });
      if (data?.error === 'two_factor_required' && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(TWO_FACTOR_REQUIRED_EVENT));
      throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? res.statusText, data?.details);
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  });
}

/** Human message for an error: translated by API error code when we have a string for it, else the API's own text. */
export function errorMessage(err: unknown, t: TFn): string {
  if (err instanceof ApiError) {
    if (err.code === 'network') return t('common.network');
    const key = `err.${err.code}` as TKey;
    const translated = t(key);
    if (translated !== key) return err.code === 'plan_limit' && err.message ? err.message : translated;
    if (err.status < 500 && err.message) return err.message;
  }
  return t('common.error');
}
