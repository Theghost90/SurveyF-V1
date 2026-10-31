'use client';
import { Toaster as Sonner } from 'sonner';

export function Toaster() {
  return <Sonner position="top-right" toastOptions={{ classNames: { toast: 'rounded-2xl border border-line font-sans', title: 'font-semibold' } }} />;
}
