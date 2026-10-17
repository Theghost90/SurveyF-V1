import { AppShell } from '@/components/app-shell';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  // The simulator is a local/demo tool: only linked when the API runs the mock WhatsApp gateway.
  const showSimulator = process.env.WHATSAPP_MODE !== 'live' && process.env.NODE_ENV !== 'production';
  return <AppShell showSimulator={showSimulator}>{children}</AppShell>;
}
