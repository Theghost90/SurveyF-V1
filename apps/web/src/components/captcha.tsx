'use client';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n/client';

/**
 * Cloudflare Turnstile (the free CAPTCHA). Rendered only when the API says one is configured. The token it hands over is checked by the API with the secret
 * key: "I passed" in the browser means nothing by itself. A token works once, so `resetKey` makes a fresh widget after every attempt.
 */
declare global {
  interface Window { turnstile?: { render(el: HTMLElement, o: Record<string, unknown>): string; reset(id?: string): void; remove(id?: string): void } }
}

let loading: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = Object.assign(document.createElement('script'), { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', async: true, defer: true });
    s.onload = () => resolve();
    s.onerror = () => { loading = null; reject(new Error('turnstile')); };
    document.head.appendChild(s);
  });
  return loading;
}

export function Captcha({ siteKey, onToken, resetKey = 0 }: { siteKey: string; onToken: (token: string | null) => void; resetKey?: number }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const cb = useRef(onToken);
  cb.current = onToken;

  useEffect(() => {
    let id: string | undefined;
    let gone = false;
    cb.current(null);
    loadTurnstile().then(() => {
      if (gone || !box.current || !window.turnstile) return;
      id = window.turnstile.render(box.current, {
        sitekey: siteKey,
        callback: (token: string) => cb.current(token),
        'expired-callback': () => cb.current(null),
        'error-callback': () => cb.current(null),
      });
    }).catch(() => setFailed(true));
    return () => { gone = true; if (id) window.turnstile?.remove(id); };
  }, [siteKey, resetKey]);

  return (
    <div>
      <div ref={box} data-testid="captcha" />
      {failed && <p role="alert" className="text-xs font-medium text-destructive">{t('lg.captchaLoad')}</p>}
    </div>
  );
}
