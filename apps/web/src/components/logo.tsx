import Link from 'next/link';
import { cn } from '@/lib/utils';

/** The design's mark: a WhatsApp-style bubble holding three rising answer bars. */
export function LogoMark({ size = 36, bars = '#2BD46E', bubble = '#0B2B22' }: { size?: number; bars?: string; bubble?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <path d="M18 3C9.7 3 3 9.2 3 16.8c0 3 1 5.7 2.8 8L4.5 32l7.6-2.6c1.8.7 3.8 1.1 5.9 1.1 8.3 0 15-6.2 15-13.7S26.3 3 18 3z" fill={bubble} />
      <rect x="11" y="17" width="3" height="6" rx="1.5" fill={bars} />
      <rect x="16.5" y="13" width="3" height="10" rx="1.5" fill={bars} />
      <rect x="22" y="9.5" width="3" height="13.5" rx="1.5" fill="#E9A23B" />
    </svg>
  );
}

export function Logo({ href = '/', className, light }: { href?: string; className?: string; light?: boolean }) {
  return (
    <Link href={href} className={cn('flex items-center gap-2.5 no-underline', className)}>
      <LogoMark bubble={light ? '#FFFFFF' : '#0B2B22'} bars={light ? '#0B2B22' : '#2BD46E'} />
      <span className={cn('font-display text-[22px] font-extrabold tracking-[-0.02em]', light ? 'text-white' : 'text-ink')}>SurveyFlow</span>
    </Link>
  );
}
