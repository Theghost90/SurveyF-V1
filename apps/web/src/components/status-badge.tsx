'use client';
import { Badge } from '@/components/ui/badge';
import { useT } from '@/lib/i18n/client';

export function SurveyStatusBadge({ status }: { status: string }) {
  const t = useT();
  const variant = status === 'active' ? 'brand' : status === 'paused' ? 'warn' : status === 'closed' ? 'dark' : 'neutral';
  return <Badge variant={variant}>{t(`status.${status}` as 'status.draft')}</Badge>;
}
