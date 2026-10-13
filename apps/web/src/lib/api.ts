import { signOut } from 'next-auth/react';
import type { TFn, TKey } from './i18n';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, any>, public issues?: Array<{ path: string; message: string }>) {
    super(message);
  }
}

/** Browser → Next proxy (/proxy/*) → API. The proxy attaches the bearer token server-side, so it never reaches page JS. */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown; form?: FormData; signal?: AbortSignal } = {}): Promise<T> {
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
  if (res.status === 401 && !path.startsWith('/auth/')) {
    void signOut({ callbackUrl: '/login' });
    throw new ApiError(401, 'unauthorized', 'unauthorized');
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? res.statusText, data?.details, data?.issues);
  return (data ?? undefined) as T;
}

/** Downloads a binary export through the proxy (keeps the filename the API chose). */
export async function download(path: string, fallbackName: string) {
  const res = await fetch(`/proxy${path}`, { cache: 'no-store' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? res.statusText, data?.details);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
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
