import type { NextAuthOptions } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';

export const API_URL = process.env.API_URL ?? 'http://localhost:4223';
/** The website's server proves who it is to the API with a shared secret; the API refuses every non-public call without it. Server-side only. */
export const internalHeaders = (): Record<string, string> => (process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {});
const googleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.INTERNAL_API_SECRET);

export const authOptions: NextAuthOptions = {
  // Backend access tokens last 12h; keep the browser session in step with them.
  session: { strategy: 'jwt', maxAge: 12 * 60 * 60 },
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      name: 'Email and password',
      credentials: { email: { label: 'Email', type: 'email' }, password: { label: 'Password', type: 'password' } },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials.password) return null;
        try {
          const res = await fetch(`${API_URL}/api/auth/login`, {
            method: 'POST',
            // Forward the real client IP so the API's login rate limit is per person, not one shared bucket for everyone.
            headers: { 'Content-Type': 'application/json', ...internalHeaders(), ...(req?.headers?.['x-forwarded-for'] ? { 'x-forwarded-for': String(req.headers['x-forwarded-for']) } : {}) },
            body: JSON.stringify({ email: credentials.email, password: credentials.password }),
            cache: 'no-store',
          });
          if (!res.ok) return null;
          const { token, user } = await res.json();
          return { id: user.id, email: user.email, name: user.name, apiToken: token };
        } catch {
          return null;
        }
      },
    }),
    ...(googleEnabled ? [Google({ clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! })] : []),
  ],
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider !== 'google') return true;
      // Google already verified the identity; ask the API (server to server, shared secret) for a session token.
      try {
        const res = await fetch(`${API_URL}/api/auth/oauth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...internalHeaders() },
          body: JSON.stringify({ email: user.email, name: user.name ?? '' }),
          cache: 'no-store',
        });
        if (!res.ok) return false;
        const { token, user: u } = await res.json();
        user.apiToken = token;
        user.id = u.id;
        return true;
      } catch {
        return false;
      }
    },
    async jwt({ token, user }) {
      if (user) {
        token.apiToken = user.apiToken;
        token.uid = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) session.user.id = token.uid ?? (token.sub as string);
      return session;
    },
  },
};

export const googleSignInEnabled = googleEnabled;
