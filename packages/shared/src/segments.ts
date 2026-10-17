/**
 * Who the owner is. Chosen once during onboarding (and editable in Settings). It is the hook for segment-specific
 * features when building and sharing surveys; which features each segment gets is NOT defined yet (docs/DECISIONS.md §3.3).
 */
export const CUSTOMER_SEGMENTS = ['business', 'institution', 'academic'] as const;
export type CustomerSegment = (typeof CUSTOMER_SEGMENTS)[number];
export const isSegment = (v: unknown): v is CustomerSegment => (CUSTOMER_SEGMENTS as readonly unknown[]).includes(v);
