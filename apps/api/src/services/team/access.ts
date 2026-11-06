/**
 * What a team member may reach in somebody else's workspace (BIZ-04). DENY BY DEFAULT: a route that is not in this table cannot be reached by a member, whatever it
 * does, so a route added tomorrow starts closed. The table is checked in one place (`plugins/auth.ts`), before any handler runs, and a test walks EVERY route of the API
 * and proves that each one not listed here refuses a member, and that every listed route still exists.
 *
 * Two roles, and only two. `viewer`: the surveys and their aggregate results; no participants, no sending. `editor`: also the participants (masked numbers, as the owner
 * sees them in lists), writing and sending surveys. What nobody but the owner can do, on purpose: anything that takes participant data out (exports, revealing a number,
 * bulk deletes, the CSV of people who did not answer), anything with money (wallet, payments, subscription, gifts released or retried, the prize draw), connections
 * (WhatsApp, Google, Sheets), deleting a survey, account and sign-in settings, the owner's own security, and managing the team itself. There is no admin role: a member
 * can never create another member, so there is no way to widen access from inside.
 */
export type TeamRole = 'viewer' | 'editor';
export const TEAM_ROLES: readonly TeamRole[] = ['viewer', 'editor'];
const RANK: Record<TeamRole, number> = { viewer: 1, editor: 2 };

/** `METHOD /route/pattern` (as registered, with its :params) to the least role that may call it. */
export const MEMBER_ROUTES: Readonly<Record<string, TeamRole>> = {
  // the shell of the app and the surveys' results
  'GET /api/auth/me': 'viewer',
  'GET /api/surveys': 'viewer',
  'GET /api/surveys/:id': 'viewer',
  'GET /api/surveys/:id/analytics': 'viewer',
  // participants (masked) and what was answered
  'GET /api/contacts': 'editor',
  'POST /api/contacts': 'editor',
  'PATCH /api/contacts/:id': 'editor',
  'DELETE /api/contacts/:id': 'editor',
  'POST /api/contacts/import': 'editor',
  'POST /api/contacts/bulk-tag': 'editor',
  'GET /api/surveys/:id/recipients': 'editor',
  'GET /api/surveys/:id/responses': 'editor',
  'GET /api/surveys/:id/not-started': 'editor',
  'GET /api/surveys/:id/gifts': 'editor',
  'GET /api/whatsapp/accounts': 'editor',
  // writing and sending surveys
  'POST /api/surveys': 'editor',
  'PUT /api/surveys/:id': 'editor',
  'POST /api/surveys/:id/duplicate': 'editor',
  'POST /api/surveys/:id/publish': 'editor',
  'POST /api/surveys/:id/pause': 'editor',
  'POST /api/surveys/:id/resume': 'editor',
  'POST /api/surveys/:id/close': 'editor',
  'POST /api/surveys/:id/audience': 'editor',
  'POST /api/surveys/:id/send': 'editor',
  'POST /api/surveys/:id/remind': 'editor',
};

export const memberRoleFor = (method: string, pattern: string): TeamRole | null => MEMBER_ROUTES[`${method} ${pattern}`] ?? null;
export const roleAllows = (have: TeamRole, need: TeamRole): boolean => RANK[have] >= RANK[need];
