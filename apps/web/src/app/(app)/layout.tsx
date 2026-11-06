import { AppShell } from '@/components/app-shell';
import { DemoNotice } from '@/components/demo-notice';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  // The simulator is a local/demo tool: only linked when the API runs the mock WhatsApp gateway, in development or in an explicit demo (SF_DEMO=1,
  // see scripts/share-demo.mjs: a production build that a tester reaches over the internet, with everything simulated).
  const showSimulator = process.env.WHATSAPP_MODE !== 'live' && (process.env.NODE_ENV !== 'production' || process.env.SF_DEMO === '1');
  return <><DemoNotice /><AppShell showSimulator={showSimulator}>{children}</AppShell></>;
}
