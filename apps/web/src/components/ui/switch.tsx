'use client';
import * as React from 'react';
import * as S from '@radix-ui/react-switch';
import { cn } from '@/lib/utils';

export const Switch = React.forwardRef<React.ElementRef<typeof S.Root>, React.ComponentPropsWithoutRef<typeof S.Root>>(({ className, ...p }, ref) => (
  <S.Root ref={ref} className={cn('peer inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent bg-line-2 transition-colors data-[state=checked]:bg-leaf disabled:cursor-not-allowed disabled:opacity-50', className)} {...p}>
    <S.Thumb className="pointer-events-none block h-6 w-6 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0" />
  </S.Root>
));
Switch.displayName = 'Switch';
