import { SurveyBuilder } from '@/components/survey-builder/builder';

export default function SurveyPage({ params }: { params: { id: string } }) {
  return <SurveyBuilder id={params.id} />;
}
