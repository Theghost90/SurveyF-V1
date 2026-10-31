'use client';
import * as React from 'react';
import * as R from '@radix-ui/react-radio-group';
import { cn } from '@/lib/utils';

export const RadioGroup = React.forwardRef<React.ElementRef<typeof R.Root>, React.ComponentPropsWithoutRef<typeof R.Root>>(({ className, ...p }, ref) => (
  <R.Root ref={ref} className={cn('grid gap-2', className)} {...p} />
));
RadioGroup.displayName = 'RadioGroup';
export const RadioGroupItem = React.forwardRef<React.ElementRef<typeof R.Item>, React.ComponentPropsWithoutRef<typeof R.Item>>(({ className, ...p }, ref) => (
  <R.Item ref={ref} className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-input bg-white data-[state=checked]:border-leaf', className)} {...p}>
    <R.Indicator className="h-2.5 w-2.5 rounded-full bg-leaf" />
  </R.Item>
));
RadioGroupItem.displayName = 'RadioGroupItem';
