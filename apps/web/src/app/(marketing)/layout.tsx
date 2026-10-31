import { DemoNotice } from '@/components/demo-notice';
import { MarketingFooter } from '@/components/marketing/footer';

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col overflow-x-clip">
      <DemoNotice />
      <div className="flex-1">{children}</div>
      <MarketingFooter />
    </div>
  );
}
