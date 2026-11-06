import { cn } from '@/lib/utils';

/** Plain-div progress bar (accessible role=progressbar), tinted by how full it is. */
export function Progress({ value, max, className, label }: { value: number; max: number | null; className?: string; label?: string }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  const tone = !max ? 'bg-brand' : pct >= 100 ? 'bg-destructive' : pct >= 80 ? 'bg-amber' : 'bg-brand';
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max ?? undefined} className={cn('h-2.5 w-full overflow-hidden rounded-full bg-muted', className)}>
      <div className={cn('h-full rounded-full transition-all', tone)} style={{ width: max ? `${pct}%` : '8%' }} />
    </div>
  );
}
