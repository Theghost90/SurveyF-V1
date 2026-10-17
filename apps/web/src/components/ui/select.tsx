'use client';
import * as React from 'react';
import * as S from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Select = S.Root;
export const SelectValue = S.Value;
export const SelectTrigger = React.forwardRef<React.ElementRef<typeof S.Trigger>, React.ComponentPropsWithoutRef<typeof S.Trigger>>(({ className, children, ...p }, ref) => (
  <S.Trigger ref={ref} className={cn('flex h-11 w-full items-center justify-between gap-2 rounded-xl border border-input bg-white px-3.5 text-[15px] disabled:opacity-60 [&>span]:truncate', className)} {...p}>
    {children}
    <S.Icon asChild><ChevronDown className="h-4 w-4 opacity-60" aria-hidden /></S.Icon>
  </S.Trigger>
));
SelectTrigger.displayName = 'SelectTrigger';
export const SelectContent = React.forwardRef<React.ElementRef<typeof S.Content>, React.ComponentPropsWithoutRef<typeof S.Content>>(({ className, children, position = 'popper', ...p }, ref) => (
  <S.Portal>
    <S.Content ref={ref} position={position} className={cn('z-50 max-h-72 min-w-[8rem] overflow-hidden rounded-2xl border border-line bg-white shadow-float data-[state=open]:animate-in data-[state=open]:fade-in-0', position === 'popper' && 'w-[var(--radix-select-trigger-width)] translate-y-1', className)} {...p}>
      <S.Viewport className="p-1.5">{children}</S.Viewport>
    </S.Content>
  </S.Portal>
));
SelectContent.displayName = 'SelectContent';
export const SelectItem = React.forwardRef<React.ElementRef<typeof S.Item>, React.ComponentPropsWithoutRef<typeof S.Item>>(({ className, children, ...p }, ref) => (
  <S.Item ref={ref} className={cn('relative flex cursor-pointer select-none items-center rounded-xl py-2.5 pl-8 pr-3 text-sm outline-none data-[highlighted]:bg-mint/60', className)} {...p}>
    <span className="absolute left-2.5 flex h-4 w-4 items-center justify-center"><S.ItemIndicator><Check className="h-4 w-4 text-leaf" aria-hidden /></S.ItemIndicator></span>
    <S.ItemText>{children}</S.ItemText>
  </S.Item>
));
SelectItem.displayName = 'SelectItem';
