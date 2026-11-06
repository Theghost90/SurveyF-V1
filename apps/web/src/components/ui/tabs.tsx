'use client';
import * as React from 'react';
import * as T from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';

export const Tabs = T.Root;
export const TabsList = React.forwardRef<React.ElementRef<typeof T.List>, React.ComponentPropsWithoutRef<typeof T.List>>(({ className, ...p }, ref) => (
  <T.List ref={ref} className={cn('inline-flex flex-wrap items-center gap-1 rounded-2xl bg-white p-1 border border-line', className)} {...p} />
));
TabsList.displayName = 'TabsList';
export const TabsTrigger = React.forwardRef<React.ElementRef<typeof T.Trigger>, React.ComponentPropsWithoutRef<typeof T.Trigger>>(({ className, ...p }, ref) => (
  <T.Trigger ref={ref} className={cn('inline-flex min-h-[40px] items-center justify-center gap-2 whitespace-nowrap rounded-xl px-4 text-sm font-semibold text-body transition-colors data-[state=active]:bg-ink data-[state=active]:text-white', className)} {...p} />
));
TabsTrigger.displayName = 'TabsTrigger';
export const TabsContent = React.forwardRef<React.ElementRef<typeof T.Content>, React.ComponentPropsWithoutRef<typeof T.Content>>(({ className, ...p }, ref) => (
  <T.Content ref={ref} className={cn('mt-5 animate-fade-up', className)} {...p} />
));
TabsContent.displayName = 'TabsContent';
