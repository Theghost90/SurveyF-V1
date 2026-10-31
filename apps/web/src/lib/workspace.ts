/**
 * Which workspace this browser is working on (BIZ-04). Empty means the person's own account, which is what everybody who works alone always has.
 * The choice is only a request: the API checks the membership, the role and the person's own second factor on every call, so a stale or forged value gets a refusal,
 * never somebody else's data. It lives in this browser only.
 */
const KEY = 'sf.workspace';
export const WORKSPACE_ID = /^[A-Za-z0-9_-]{10,40}$/;

export function currentWorkspace(): string | null {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    return v && WORKSPACE_ID.test(v) ? v : null;
  } catch { return null; }
}

export function setWorkspace(id: string | null): void {
  try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* storage blocked: the person stays on their own account */ }
}

/**
 * The header that names the workspace, for the calls that belong to it. Not for the person's OWN things (signing in and their own security `/auth/…`, their invitations
 * and memberships `/team/…`, their own data `/account/…`), which always act on their own account; the one exception is reading the account summary (GET /auth/me), which
 * is how the app learns the workspace's plan and the person's role in it.
 */
export function workspaceHeaders(path: string, method = 'GET'): Record<string, string> {
  const id = currentWorkspace();
  if (!id) return {};
  const own = /^\/(auth|team|account)\//.test(path) && !(method === 'GET' && path.split('?')[0] === '/auth/me');
  return own ? {} : { 'x-workspace': id };
}
