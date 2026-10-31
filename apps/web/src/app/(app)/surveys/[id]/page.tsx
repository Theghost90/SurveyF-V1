import { SurveyBuilder } from '@/components/survey-builder/builder';

export default async function SurveyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SurveyBuilder id={id} />;
}
