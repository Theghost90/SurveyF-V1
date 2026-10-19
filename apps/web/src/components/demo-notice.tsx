import { getT } from '@/lib/i18n/server';

/** Shown on every page while the site runs as a shared test (SF_DEMO=1): testers must know nothing real happens here. */
export function DemoNotice() {
  if (process.env.SF_DEMO !== '1') return null;
  const { t } = getT();
  return <div role="note" className="bg-amber-soft px-4 py-1.5 text-center text-xs font-semibold text-amber-ink">{t('demo.notice')}</div>;
}
