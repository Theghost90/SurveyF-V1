'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Mail } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n/client';

interface Item { kind: string; links: string[] }

/**
 * Demo and development only (the API is using the mock e-mail provider): nothing is really sent, so the page shows the message itself. This is what lets a tester
 * go through sign-up and password reset without a mailbox. It is never rendered for a real provider (the form checks `emailMode === 'demo'`).
 */
export function DemoMailbox({ email, kind, match }: { email: string; kind: 'verify_email' | 'reset_password'; match: string }) {
  const t = useT();
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    if (!email) return;
    let stop = false;
    const look = async () => {
      try {
        const { items } = await api<{ items: Item[] }>(`/dev/mailbox?to=${encodeURIComponent(email)}`);
        const link = items.find((i) => i.kind === kind)?.links.find((l) => l.includes(match));
        if (link && !stop) { const u = new URL(link); setHref(u.pathname + u.search); }
      } catch { /* not there yet */ }
    };
    void look();
    const id = setInterval(look, 2500);
    return () => { stop = true; clearInterval(id); };
  }, [email, kind, match]);

  return (
    <div className="mt-5 rounded-2xl border border-amber/50 bg-amber-soft p-4 text-sm text-amber-ink" data-testid="demo-mailbox">
      <p className="flex items-center gap-2 font-bold"><Mail className="h-4 w-4" aria-hidden />{t('ce.demoTitle')}</p>
      <p className="mt-1">{t('ce.demoText')}</p>
      {href ? <Link href={href} className={buttonVariants({ size: 'sm', className: 'mt-3' })} data-testid="demo-link">{t('ce.demoOpen')}</Link> : <p className="mt-2 opacity-80">{t('ce.demoNone')}</p>}
      <p className="mt-3 text-xs opacity-80">{t('ce.demoWarn')}</p>
    </div>
  );
}
