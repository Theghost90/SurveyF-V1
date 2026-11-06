import { cn } from '@/lib/utils';
export const Skeleton = ({ className }: { className?: string }) => <div aria-hidden className={cn('animate-pulse rounded-xl bg-muted', className)} />;
