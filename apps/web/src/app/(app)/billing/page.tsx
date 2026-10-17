'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { SubscriptionPage } from '@/components/billing/subscription-page';

function Inner() {
  const p = useSearchParams();
  return <SubscriptionPage initialPlan={p.get('plan') ?? undefined} initialInterval={p.get('interval') ?? undefined} />;
}
export default function BillingPage() {
  return <Suspense><Inner /></Suspense>;
}
