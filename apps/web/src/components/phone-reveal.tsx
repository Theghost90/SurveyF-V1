'use client';
import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { formatPhone } from '@surveyflow/shared';
import { api, errorMessage } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

/**
 * A participant's phone number, hidden until asked for. One number at a time, limited and written to the owner's activity log by the API; it hides itself again
 * after half a minute. (Everything else on the screen shows the masked number the API sends.)
 */
export function RevealablePhone({ contactId, masked, className }: { contactId: string; masked: string; className?: string }) {
  const t = useT();
  const [full, setFull] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function show() {
    setBusy(true);
    try {
      const r = await api<{ phone: string }>(`/contacts/${contactId}/reveal`, { method: 'POST' });
      setFull(formatPhone(r.phone));
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setFull(null), 30_000);
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally { setBusy(false); }
  }
  function hide() { clearTimeout(timer.current); setFull(null); }

  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums', className)}>
      <span data-testid="phone">{full ?? formatPhone(masked)}</span>
      <button
        type="button" onClick={full ? hide : show} disabled={busy} aria-label={full ? t('c.hide') : t('c.reveal')} title={full ? t('c.hide') : t('c.reveal')}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-mint/60 hover:text-ink disabled:opacity-50"
      >
        {full ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
      </button>
    </span>
  );
}
