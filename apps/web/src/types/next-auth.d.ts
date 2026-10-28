import 'next-auth';
import 'next-auth/jwt';

declare module 'next-auth' {
  interface Session {
    user: { id: string; name?: string | null; email?: string | null };
    /** Set when the sign-in is over (it ran past its end, or was ended elsewhere): the page signs the visitor out. */
    error?: string;
  }
  interface User {
    sid?: string;
    apiToken?: string;
    apiTokenExp?: number;
    refreshToken?: string;
    sessionExp?: number;
  }
}
declare module 'next-auth/jwt' {
  interface JWT {
    uid?: string;
    /** The API's session this cookie belongs to. */
    sid?: string;
    /** Short-lived API bearer token. Lives only in the encrypted httpOnly cookie; the proxy attaches it server-side and renews it. */
    apiToken?: string;
    apiTokenExp?: number;
    /** Renews the API token; rotated every time it is used. Never leaves the cookie. */
    refreshToken?: string;
    /** When the sign-in ends for good (ms since the epoch). */
    sessionExp?: number;
    error?: string;
  }
}
