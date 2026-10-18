'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import * as D from '@radix-ui/react-dialog';
import { Menu, X } from 'lucide-react';
import { LogoMark } from '@/components/logo';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface MobileMenuLabels { open: string; close: string; menu: string; signin: string; trial: string; dashboard: string; privacy: string; terms: string }
export interface MobileMenuLink { href: string; label: string; current?: boolean }

/**
 * Phone navigation of the public site (below 640 px): a hamburger that opens a side menu from the right.
 * The bar itself (logo, language switch, "Explore free", this button) stays visible while scrolling; the menu holds the page links,
 * "Sign in" and the full-size call to action, so nothing is lost by the compact bar.
 */
export function MobileMenu({ links, signedIn, labels }: { links: MobileMenuLink[]; signedIn: boolean; labels: MobileMenuLabels }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  const row = 'flex min-h-[52px] items-center border-b border-line-3 px-1 text-[17px] font-semibold text-ink no-underline hover:text-leaf';

  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Trigger aria-label={labels.open} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line-2 bg-white text-ink sm:hidden">
        <Menu className="h-5 w-5" aria-hidden />
      </D.Trigger>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-ink/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 sm:hidden" />
        <D.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-[min(86vw,340px)] flex-col bg-white px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3 shadow-float data-[state=open]:animate-in data-[state=open]:slide-in-from-right sm:hidden"
        >
          <D.Title className="sr-only">{labels.menu}</D.Title>
          <div className="flex items-center justify-between pb-2">
            <LogoMark size={30} />
            <D.Close aria-label={labels.close} className="flex h-11 w-11 items-center justify-center rounded-xl text-ink hover:bg-canvas">
              <X className="h-5 w-5" aria-hidden />
            </D.Close>
          </div>
          <nav aria-label={labels.menu} className="flex-1 overflow-y-auto">
            {links.map((l) => (
              <Link key={l.href} href={l.href} aria-current={l.current ? 'page' : undefined} onClick={() => setOpen(false)} className={cn(row, l.current && 'text-leaf')}>{l.label}</Link>
            ))}
            {!signedIn && <Link href="/login" onClick={() => setOpen(false)} className={row}>{labels.signin}</Link>}
          </nav>
          <div className="flex flex-col gap-4 pt-4">
            {signedIn
              ? <Link href="/dashboard" className={buttonVariants({ size: 'lg', className: 'w-full' })}>{labels.dashboard}</Link>
              : <Link href="/register" className={buttonVariants({ size: 'lg', className: 'w-full' })}>{labels.trial}</Link>}
            <p className="flex justify-center gap-4 text-xs text-muted-foreground">
              <Link href="/privacy" className="hover:text-leaf">{labels.privacy}</Link>
              <Link href="/terms" className="hover:text-leaf">{labels.terms}</Link>
            </p>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
