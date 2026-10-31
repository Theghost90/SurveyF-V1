'use client';
import * as React from 'react';
import * as C from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Checkbox = React.forwardRef<React.ElementRef<typeof C.Root>, React.ComponentPropsWithoutRef<typeof C.Root>>(({ className, ...p }, ref) => (
  <C.Root ref={ref} className={cn('peer flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 border-input bg-white data-[state=checked]:border-leaf data-[state=checked]:bg-leaf disabled:opacity-50', className)} {...p}>
    <C.Indicator><Check className="h-3.5 w-3.5 text-white" strokeWidth={3} aria-hidden /></C.Indicator>
  </C.Root>
));
Checkbox.displayName = 'Checkbox';
