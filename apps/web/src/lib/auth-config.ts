'use client';
import useSWR from 'swr';

/** What the API says the sign-in and sign-up forms need (public: it says nothing about any account). */
export interface AuthConfig {
  captcha: { provider: 'turnstile'; siteKey: string } | null;
  /** `demo`: e-mails are not sent, the page shows them (test instances only). */
  emailMode: 'demo' | 'live';
  passwordMinLength: number;
  googleSignIn: boolean;
}

export function useAuthConfig(): AuthConfig | undefined {
  return useSWR<AuthConfig>('/auth/config', { revalidateOnFocus: false, dedupingInterval: 300_000 }).data;
}
