import { TEMPLATE_NAMES, classifySurvey, withTemplateState, type CategoryReason, type MessageCategory } from '@surveyflow/shared';
import { prisma } from '../lib/prisma';

/**
 * The category an invitation is sent under, decided here (WA-03). The rules are in packages/shared/src/message-category.ts: marketing unless the survey
 * follows something the person did, carries no reward and reads as no promotion. On top of that, what Meta has done to the utility template of THIS WhatsApp
 * account counts: once it has moved it to marketing, every survey on that account costs the marketing rate whatever it says.
 */
export interface InvitationPlan {
  category: MessageCategory;
  reasons: CategoryReason[];
  /** The template the invitation goes out with: the utility one only for a utility survey. */
  templateName: string;
}

interface SurveyForCategory {
  title: string; description: string | null; customThankYou: string | null; followsTransaction: boolean; giftType: string; language: string;
  questions: Array<{ text: string; options: unknown }>;
}

export async function invitationPlan(survey: SurveyForCategory, accountId: string | null): Promise<InvitationPlan> {
  const base = classifySurvey({
    title: survey.title, description: survey.description, customThankYou: survey.customThankYou, followsTransaction: survey.followsTransaction, giftType: survey.giftType,
    questions: survey.questions.map((q) => ({ text: q.text, options: Array.isArray(q.options) ? (q.options as Array<{ label?: string }>) : null })),
  });
  const row = accountId ? await utilityTemplate(accountId, survey.language) : null;
  const { category, reasons } = withTemplateState(base, row && { category: row.category, pendingCategory: row.categoryPending, pendingAt: row.categoryPendingAt });
  return { category, reasons, templateName: category === 'utility' ? TEMPLATE_NAMES.invitation : TEMPLATE_NAMES.invitationMarketing };
}

/** The stored state of the account's utility invitation template (what Meta says it is now, and any change it has announced). */
export const utilityTemplate = (accountId: string, language: string) =>
  prisma.messageTemplate.findUnique({ where: { accountId_name_language: { accountId, name: TEMPLATE_NAMES.invitation, language } } });

/** True when an invitation queued as utility must not go out as one any more: Meta has moved that template to marketing since the owner accepted the cost. */
export async function utilityHasChanged(accountId: string, language: string): Promise<boolean> {
  const row = await utilityTemplate(accountId, language);
  return !!row && row.category.toUpperCase() === 'MARKETING';
}
