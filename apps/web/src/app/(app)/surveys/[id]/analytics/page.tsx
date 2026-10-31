import { AnalyticsDashboard } from '@/components/analytics/dashboard';

export default async function AnalyticsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AnalyticsDashboard id={id} />;
}
