import 'next-auth';
import 'next-auth/jwt';

declare module 'next-auth' {
  interface Session {
    user: { id: string; name?: string | null; email?: string | null };
  }
  interface User {
    apiToken?: string;
  }
}
declare module 'next-auth/jwt' {
  interface JWT {
    /** Short-lived API bearer token. Lives only in the encrypted session cookie; the proxy attaches it server-side. */
    apiToken?: string;
    uid?: string;
  }
}
