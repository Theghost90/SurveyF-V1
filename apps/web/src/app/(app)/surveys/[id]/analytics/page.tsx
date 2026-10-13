import { AnalyticsDashboard } from '@/components/analytics/dashboard';

export default function AnalyticsPage({ params }: { params: { id: string } }) {
  return <AnalyticsDashboard id={params.id} />;
}
