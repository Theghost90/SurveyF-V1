import Link from 'next/link';
import { Logo } from '@/components/logo';
import { LanguageToggle } from '@/components/language-toggle';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-[1344px] items-center justify-between px-5 py-6 sm:px-8">
        <Logo />
        <LanguageToggle />
      </header>
      <main id="main" className="flex flex-1 items-start justify-center px-5 pb-16 pt-4 sm:items-center">{children}</main>
      <footer className="pb-6 text-center text-xs text-muted-foreground">
        <Link href="/privacy" className="hover:text-leaf">Privacy</Link> · <Link href="/terms" className="hover:text-leaf">Terms</Link>
      </footer>
    </div>
  );
}
