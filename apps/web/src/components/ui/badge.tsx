import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold', {
  variants: {
    variant: {
      default: 'bg-mint text-leaf',
      neutral: 'bg-muted text-muted-foreground',
      dark: 'bg-ink text-white',
      amber: 'bg-amber text-ink',
      warn: 'bg-amber-soft text-amber-ink',
      danger: 'bg-red-100 text-red-800',
      brand: 'bg-brand text-ink',
      outline: 'border border-line-2 text-ink',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Badge({ className, variant, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
