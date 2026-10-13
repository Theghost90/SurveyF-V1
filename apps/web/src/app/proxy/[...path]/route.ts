import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { API_URL } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Calls that work without a session. Everything else needs the bearer token from the encrypted cookie. */
const PUBLIC = new Set(['auth/register']);

async function handler(req: NextRequest, { params }: { params: { path: string[] } }) {
  const segments = params.path;
  // No traversal out of /api, and webhooks are for Meta/PSPs talking to the API directly, never for browsers.
  if (segments.some((s) => s === '..' || s === '.' || s.includes('\\') || s.toLowerCase().includes('%2e'))) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  // CSRF defence in depth (the session cookie is already SameSite=Lax): refuse cross-origin state-changing calls.
  if (!['GET', 'HEAD'].includes(req.method)) {
    const origin = req.headers.get('origin');
    const allowed = new Set([req.nextUrl.origin, process.env.NEXTAUTH_URL ? new URL(process.env.NEXTAUTH_URL).origin : '']);
    if (origin && !allowed.has(origin)) return NextResponse.json({ error: 'forbidden', message: 'Cross-origin request refused' }, { status: 403 });
  }
  const path = segments.join('/');
  if (path.startsWith('webhook/') || path.includes('/webhook/')) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const token = await getToken({ req });
  if (!token?.apiToken && !PUBLIC.has(path)) return NextResponse.json({ error: 'unauthorized', message: 'Authentication required' }, { status: 401 });

  const headers = new Headers();
  const ct = req.headers.get('content-type');
  if (ct) headers.set('content-type', ct);
  headers.set('accept', req.headers.get('accept') ?? 'application/json');
  const xff = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip');
  if (xff) headers.set('x-forwarded-for', xff); // so per-IP rate limits see the visitor, not this server
  if (token?.apiToken) headers.set('authorization', `Bearer ${token.apiToken}`);

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/api/${path}${req.nextUrl.search}`, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return NextResponse.json({ error: 'upstream_unreachable', message: 'The API is not reachable' }, { status: 502 });
  }

  const out = new Headers();
  for (const h of ['content-type', 'content-disposition', 'cache-control']) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set('cache-control', 'no-store');
  return new NextResponse(upstream.status === 204 ? null : upstream.body, { status: upstream.status, headers: out });
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
