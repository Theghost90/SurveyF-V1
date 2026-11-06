import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { readMockMailbox } from '../src/services/mail';
import { MEMBER_ROUTES } from '../src/services/team/access';
import { TEST_PASSWORD, answerIdFor, buildWorld, registerOwner, replyMsg, resetAll, say, templateBtn, textMsg, type Client, type World } from './helpers';

/**
 * BIZ-04: team members. Containment under test (docs/BACKLOG.md): roles, a per-member audit, two-factor. The risks it names: privilege escalation, and more people seeing
 * participants. What must hold: nothing changes for an owner who works alone; a member reaches ONLY what the table lists for their role (deny by default, proven over
 * every route of the API); they need their own second factor; they can never grow access from inside; an invitation only works for the person it was sent to; removal
 * and a change of role act at the very next request; everything a member does is in the team's trail with who did it.
 */
const inventory: string[] = [];
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ onRoute: (r) => { for (const m of [r.method].flat()) if (m !== 'HEAD' && m !== 'OPTIONS') inventory.push(`${m} ${r.url}`); } });
  await app.ready();
});
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); });

let n = 0;
const confirm = (c: Client) => c.post('/api/auth/step-up', { method: 'password', secret: TEST_PASSWORD });
const withTwoFactor = (userId: string) => prisma.user.update({ where: { id: userId }, data: { totpEnabledAt: new Date() } });
const asMember = (c: Client, workspaceId: string | undefined) => async (method: string, url: string, body?: unknown) => {
  const res = await app.inject({ method: method as never, url, headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json', ...(workspaceId ? { 'x-workspace': workspaceId } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { /* not json */ }
  return { status: res.statusCode, json };
};
const emailOf = async (c: Client) => (await prisma.user.findUniqueOrThrow({ where: { id: c.userId } })).email;
const tokenFor = async (email: string) => new URL((await readMockMailbox(email)).find((m) => m.kind === 'team_invite')!.links.find((l) => l.includes('/team/accept'))!).searchParams.get('token')!;

/** A new person with a login of their own (and, unless told otherwise, two-factor on), invited as `role` by `owner`, and joined. */
async function join(w: World, role: 'viewer' | 'editor', opts: { twoFactor?: boolean } = {}) {
  const email = `member${++n}@example.com`;
  const member = await registerOwner(app, { email, whatsapp: false });
  if (opts.twoFactor !== false) await withTwoFactor(member.userId);
  await confirm(w.owner);
  const inv = await w.owner.post('/api/team/invites', { email, role });
  if (inv.status !== 201) throw new Error('invite: ' + JSON.stringify(inv));
  const accepted = await member.post('/api/team/accept', { token: await tokenFor(email) });
  if (accepted.status !== 200) throw new Error('accept: ' + JSON.stringify(accepted));
  return { member, email, call: asMember(member, w.owner.userId), ws: w.owner.userId };
}
const world = (extra: Record<string, unknown> = {}) => buildWorld(app, { contacts: 3, send: false, plan: 'growth', ...extra });

describe('an owner who works alone is untouched', () => {
  it('without a workspace header everything is as before, and a header naming oneself changes nothing', async () => {
    const w = await world();
    expect((await w.owner.get('/api/surveys')).items).toHaveLength(1);
    const same = await asMember(w.owner, w.owner.userId)('GET', '/api/surveys');
    expect(same.status).toBe(200);
    expect(same.json.items).toHaveLength(1);
    expect((await w.owner.get('/api/auth/me')).user.id).toBe(w.owner.userId);
  });
});

describe('inviting', () => {
  it('needs "confirm it is you"; mails a single-use link to the address; stores only the hash of the token', async () => {
    const w = await world();
    const email = 'colleague@example.com';
    const early = await w.owner.post('/api/team/invites', { email, role: 'editor' });
    expect(early.status).toBe(403);
    expect(early.error).toBe('step_up_required');
    await confirm(w.owner);
    const inv = await w.owner.post('/api/team/invites', { email, role: 'editor' });
    expect(inv.status).toBe(201);
    const mail = (await readMockMailbox(email)).find((m) => m.kind === 'team_invite')!;
    expect(mail.text).toContain('Boulangerie Akwa');
    const token = await tokenFor(email);
    const row = await prisma.teamInvite.findFirstOrThrow();
    expect(row.tokenHash).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect((await w.owner.get('/api/team')).invites).toEqual([expect.objectContaining({ email, role: 'editor' })]);
  });

  it('refuses a bad role, yourself, an address already invited, a full team, and one who is already a member', async () => {
    const w = await world();
    await confirm(w.owner);
    expect((await w.owner.post('/api/team/invites', { email: 'a@example.com', role: 'admin' })).status).toBe(400);
    expect((await w.owner.post('/api/team/invites', { email: await emailOf(w.owner), role: 'viewer' })).error).toBe('invite_self');
    expect((await w.owner.post('/api/team/invites', { email: 'a@example.com', role: 'viewer' })).status).toBe(201);
    expect((await w.owner.post('/api/team/invites', { email: 'A@Example.com', role: 'editor' })).error).toBe('already_invited');
    // Growth: three seats including the owner, so two others: one invitation is pending, one more fits, a third does not
    expect((await w.owner.post('/api/team/invites', { email: 'b@example.com', role: 'viewer' })).status).toBe(201);
    const full = await w.owner.post('/api/team/invites', { email: 'c@example.com', role: 'viewer' });
    expect([full.status, full.error, full.details]).toEqual([402, 'plan_limit', expect.objectContaining({ limit: 'teamMembers', max: 3 })]);
    for (const i of (await w.owner.get('/api/team')).invites) await w.owner.del(`/api/team/invites/${i.id}`);
    const j = await join(w, 'viewer');
    expect((await w.owner.post('/api/team/invites', { email: j.email, role: 'editor' })).error).toBe('already_member');
  });
});

describe('the plan\'s seats', () => {
  it('Explore and Starter have no room (one seat: the owner), Growth three, Business ten; the owner counts as one', async () => {
    for (const [plan, others] of [['trial', 0], ['starter', 0], ['growth', 2], ['business', 9]] as const) {
      await resetAll();
      const owner = await registerOwner(app, { plan, whatsapp: false });
      await confirm(owner);
      await withTwoFactor(owner.userId); // (Business requires it of an owner who has confirmed it is them; set after, so that the password confirmation above is the plain one)
      let ok = 0;
      for (let i = 0; i < 11; i++) {
        const r = await owner.post('/api/team/invites', { email: `p${plan}${i}@example.com`, role: 'viewer' });
        if (r.status === 201) ok++;
        else { expect([r.status, r.error], plan).toEqual([402, i >= 10 ? 'too_many_invites' : 'plan_limit'].slice(0, 2) as never); break; }
      }
      expect(ok, plan).toBe(Math.min(others, 10));
    }
  });

  it('a downgrade does not remove members who are in, and an invitation sent before it cannot be accepted beyond the new plan', async () => {
    const w = await world();
    const first = await join(w, 'editor');
    const email = 'late@example.com';
    await confirm(w.owner);
    await w.owner.post('/api/team/invites', { email, role: 'viewer' });
    const late = await registerOwner(app, { email, whatsapp: false });
    await prisma.subscription.updateMany({ where: { userId: w.owner.userId }, data: { plan: 'trial' } });
    await prisma.user.update({ where: { id: w.owner.userId }, data: { plan: 'trial' } });
    expect((await first.call('GET', '/api/contacts')).status).toBe(200); // the member already in keeps working
    const refused = await late.post('/api/team/accept', { token: await tokenFor(email) });
    expect([refused.status, refused.error]).toEqual([409, 'team_full']);
  });
});

describe('accepting', () => {
  const invite = async (w: World, email: string, role = 'editor') => { await confirm(w.owner); await w.owner.post('/api/team/invites', { email, role }); return tokenFor(email); };

  it('makes the signed-in person with that confirmed address a member, tells the owner, and the link works once', async () => {
    const w = await world();
    const email = 'carole@example.com';
    const carole = await registerOwner(app, { email, whatsapp: false });
    const token = await invite(w, email, 'viewer');
    const ok = await carole.post('/api/team/accept', { token });
    expect(ok).toMatchObject({ workspaceId: w.owner.userId, businessName: 'Boulangerie Akwa', role: 'viewer' });
    expect((await carole.post('/api/team/accept', { token })).status).toBe(410);
    expect((await readMockMailbox(await emailOf(w.owner))).filter((m) => m.kind === 'team_joined')).toHaveLength(1);
    expect((await carole.get('/api/team/workspaces')).items).toEqual([{ workspaceId: w.owner.userId, businessName: 'Boulangerie Akwa', role: 'viewer' }]);
    expect((await w.owner.get('/api/team')).members).toEqual([expect.objectContaining({ email, role: 'viewer', twoFactor: false })]);
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: 'team_member_joined' } })).toMatchObject({ userId: w.owner.userId, actorId: carole.userId });
  });

  it('is refused to anybody else, with the same answer for every reason the link is not valid, and the right person can still use it afterwards', async () => {
    const w = await world();
    const email = 'dave@example.com';
    const token = await invite(w, email);
    const stranger = await registerOwner(app, { whatsapp: false });
    const wrong = await stranger.post('/api/team/accept', { token });
    expect(wrong.status).toBe(403);
    expect(wrong.error).toBe('invite_wrong_account');
    const unconfirmed = await registerOwner(app, { email, whatsapp: false, verified: false });
    expect((await asMember(unconfirmed, undefined)('POST', '/api/team/accept', { token })).status).toBe(403); // an unconfirmed address proves nothing
    expect(await prisma.teamMember.count()).toBe(0);
    await prisma.user.update({ where: { id: unconfirmed.userId }, data: { emailVerifiedAt: new Date() } });
    expect((await unconfirmed.post('/api/team/accept', { token })).status).toBe(200);
    // not valid, whatever the cause: nothing says which
    const expired = await invite(w, 'ed@example.com');
    await prisma.teamInvite.updateMany({ where: { emailCanonical: 'ed@example.com' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const ed = await registerOwner(app, { email: 'ed@example.com', whatsapp: false });
    const revoked = await invite(w, 'fay@example.com');
    const inv = await prisma.teamInvite.findFirstOrThrow({ where: { emailCanonical: 'fay@example.com' } });
    await confirm(w.owner);
    await w.owner.del(`/api/team/invites/${inv.id}`);
    const fay = await registerOwner(app, { email: 'fay@example.com', whatsapp: false });
    const answers = [await ed.post('/api/team/accept', { token: expired }), await fay.post('/api/team/accept', { token: revoked }), await fay.post('/api/team/accept', { token: 'x'.repeat(40) })];
    expect(answers.map((a) => [a.status, a.error])).toEqual([[410, 'invite_invalid'], [410, 'invite_invalid'], [410, 'invite_invalid']]);
  });
});

describe('entering a workspace', () => {
  it('is refused to a person who is not a member (a stranger, another owner, a malformed id) and never says anything else about the workspace', async () => {
    const a = await world();
    const b = await world();
    const stranger = await registerOwner(app, { whatsapp: false });
    await withTwoFactor(stranger.userId);
    for (const ws of [a.owner.userId, b.owner.userId, 'no-such-user-id-1234', '../etc', 'x']) {
      const r = await asMember(stranger, ws)('GET', '/api/surveys');
      expect([r.status, r.json.error], ws).toEqual([403, 'not_a_member']);
    }
    // an owner is no member of another owner's workspace by being an owner
    expect((await asMember(a.owner, b.owner.userId)('GET', '/api/surveys')).json.error).toBe('not_a_member');
    expect(await prisma.auditLog.count({ where: { action: 'member_denied' } })).toBe(0); // a non-member leaves nothing in the owner's trail
  });

  it('needs the member\'s OWN second factor, on every request', async () => {
    const w = await world();
    const j = await join(w, 'editor', { twoFactor: false });
    const no = await j.call('GET', '/api/surveys');
    expect([no.status, no.json.error]).toEqual([403, 'two_factor_required']);
    await withTwoFactor(j.member.userId);
    expect((await j.call('GET', '/api/surveys')).status).toBe(200);
    await prisma.user.update({ where: { id: j.member.userId }, data: { totpEnabledAt: null } });
    expect((await j.call('GET', '/api/surveys')).json.error).toBe('two_factor_required'); // switching it off ends the access at once
  });

  it('keeps the member\'s own workspace separate: without the header they see only their own data', async () => {
    const w = await world();
    const j = await join(w, 'editor');
    expect((await j.member.get('/api/surveys')).items).toHaveLength(0);
    expect((await j.call('GET', '/api/surveys')).json.items).toHaveLength(1);
  });
});

describe('a viewer', () => {
  it('sees the surveys and their aggregate results, never a participant, and the account shell without the owner\'s address, number or billing', async () => {
    const w = await buildWorld(app, { contacts: 2, plan: 'growth' });
    const [q1, q2] = w.questions;
    await say(app, w, 0, (f) => templateBtn(f, `START:${w.surveyId}`));
    await say(app, w, 0, (f) => replyMsg(f, answerIdFor(q1!, 0), 'button_reply'));
    await say(app, w, 0, (f) => replyMsg(f, answerIdFor(q2!, 0), 'list_reply'));
    await say(app, w, 0, (f) => textMsg(f, 'done'));
    const j = await join(w, 'viewer');
    const list = await j.call('GET', '/api/surveys');
    expect([list.status, list.json.items.map((s: { id: string }) => s.id)]).toEqual([200, [w.surveyId]]);
    expect((await j.call('GET', `/api/surveys/${w.surveyId}`)).status).toBe(200);
    const analytics = await j.call('GET', `/api/surveys/${w.surveyId}/analytics`);
    expect(analytics.status).toBe(200);
    expect(JSON.stringify(analytics.json)).not.toMatch(/Contact 1|Contact 2|6771000|6XX/);
    expect(JSON.stringify(analytics.json)).toContain('"done"'); // the words of the free-text answer are results; the name next to them is not
    expect(analytics.json.nonStarters).toEqual([]);
    expect(analytics.json.totals.completed).toBe(1); // the counts are all there
    const editor = await join(w, 'editor');
    expect(JSON.stringify((await editor.call('GET', `/api/surveys/${w.surveyId}/analytics`)).json)).toMatch(/Contact 1/); // an editor sees the people, as the owner does
    const me = await j.call('GET', '/api/auth/me');
    expect(me.json.user).toMatchObject({ id: j.member.userId, email: j.email, phone: null });
    expect(me.json.member).toEqual({ role: 'viewer', workspaceId: w.owner.userId });
    expect(JSON.stringify(me.json)).not.toContain(await emailOf(w.owner));
    expect(me.json.subscription).toMatchObject({ amountFCFA: 0, paymentMethod: null, pspProvider: null });
    expect(me.json.user.businessName).toBe('Boulangerie Akwa'); // what the workspace is called, so the app works
  });

  it('cannot reach participants, sending, or anything an editor can', async () => {
    const w = await world();
    const j = await join(w, 'viewer');
    for (const [m, u, b] of [
      ['GET', '/api/contacts'], ['POST', '/api/contacts', { name: 'X', phone: '+237677999999', consent: true }], ['GET', `/api/surveys/${w.surveyId}/recipients`], ['GET', `/api/surveys/${w.surveyId}/responses`],
      ['POST', `/api/surveys/${w.surveyId}/send`, { all: true, acceptMarketingCost: true }], ['POST', '/api/surveys', { title: 'x' }], ['PUT', `/api/surveys/${w.surveyId}`, {}], ['GET', '/api/whatsapp/accounts'],
    ] as const) {
      const r = await j.call(m, u, b);
      expect([r.status, r.json.error], `${m} ${u}`).toEqual([403, 'forbidden_role']);
    }
    expect(await prisma.contact.count({ where: { userId: w.owner.userId } })).toBe(3);
  });
});

describe('an editor', () => {
  it('works on the OWNER\'s data: participants (masked numbers), surveys, sending, and everything they do is attributed to them', async () => {
    const w = await world();
    const j = await join(w, 'editor');
    const contacts = await j.call('GET', '/api/contacts');
    expect(contacts.status).toBe(200);
    expect(contacts.json.items).toHaveLength(3);
    expect(JSON.stringify(contacts.json)).not.toContain('+2376771000'); // masked, as in the owner's own lists
    const made = await j.call('POST', '/api/contacts', { name: 'New Person', phone: '+237677888777', consent: true });
    expect(made.status).toBe(201);
    expect(await prisma.contact.count({ where: { userId: w.owner.userId } })).toBe(4);
    expect(await prisma.contact.count({ where: { userId: j.member.userId } })).toBe(0);
    const created = await j.call('POST', '/api/surveys', { title: 'Made by the editor', language: 'en', questions: [{ text: 'Happy?', type: 'button', required: true, options: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }] }] });
    expect(created.status).toBe(201);
    expect((await prisma.survey.findUniqueOrThrow({ where: { id: created.json.id } })).userId).toBe(w.owner.userId);
    const sent = await j.call('POST', `/api/surveys/${w.surveyId}/send`, { all: true, acceptMarketingCost: true });
    expect([sent.status, sent.json.queued]).toEqual([200, 4]);
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: 'survey_sent' } })).toMatchObject({ userId: w.owner.userId, actorId: j.member.userId });
  });

  it('cannot take data out, move money, connect anything, delete a survey, change sign-in or security, or manage the team', async () => {
    const w = await world();
    const j = await join(w, 'editor');
    const sid = w.surveyId;
    for (const [m, u, b] of [
      ['GET', `/api/surveys/${sid}/export/excel`], ['GET', `/api/surveys/${sid}/export/pdf`], ['GET', `/api/surveys/${sid}/not-started.csv`], ['POST', `/api/contacts/${w.contactIds[0]}/reveal`, {}], ['POST', '/api/contacts/bulk-delete', { ids: [] }],
      ['DELETE', `/api/surveys/${sid}`], ['POST', `/api/surveys/${sid}/draw`, {}], ['POST', `/api/surveys/${sid}/gifts/release`, {}], ['POST', `/api/surveys/${sid}/gifts/retry`, {}], ['POST', `/api/surveys/${sid}/sync/google-sheets`, {}],
      ['GET', '/api/wallet'], ['POST', '/api/wallet/topup', {}], ['GET', '/api/payments'], ['GET', '/api/subscription'], ['PUT', '/api/subscription/upgrade', {}], ['POST', '/api/whatsapp/accounts', {}], ['DELETE', '/api/integrations/google'],
      ['POST', '/api/auth/password/change', {}], ['PATCH', '/api/auth/me', {}], ['GET', '/api/auth/sessions'], ['POST', '/api/auth/2fa/disable', {}], ['POST', '/api/account/export', {}], ['POST', '/api/account/delete', { confirm: 'DELETE' }],
      ['GET', '/api/team'], ['POST', '/api/team/invites', { email: 'x@example.com', role: 'editor' }], ['PATCH', `/api/team/members/${j.member.userId}`, { role: 'editor' }], ['DELETE', `/api/team/members/${j.member.userId}`], ['GET', '/api/team/activity'],
      ['POST', '/api/team/accept', { token: 'x'.repeat(30) }], ['GET', '/api/team/workspaces'], ['POST', '/api/team/leave', { workspaceId: w.owner.userId }],
    ] as const) {
      const r = await j.call(m, u, b);
      expect([r.status, r.json?.error], `${m} ${u}`).toEqual([403, 'forbidden_role']);
    }
  });

  it('cannot reach another owner\'s data by naming it, or by guessing an id inside the workspace', async () => {
    const a = await world();
    const b = await world();
    const j = await join(a, 'editor');
    expect((await asMember(j.member, b.owner.userId)('GET', `/api/surveys/${b.surveyId}`)).json.error).toBe('not_a_member');
    expect((await j.call('GET', `/api/surveys/${b.surveyId}`)).status).toBe(404); // inside A's workspace, B's survey does not exist
    expect((await j.call('PUT', `/api/surveys/${b.surveyId}`, { title: 'hijacked' })).status).toBe(404);
    expect((await prisma.survey.findUniqueOrThrow({ where: { id: b.surveyId } })).title).toBe('Customer Satisfaction');
  });
});

describe('the team\'s trail and the owner\'s own', () => {
  it('records every change a member makes with who, every refusal once a minute, and keeps all of it out of the owner\'s own security activity', async () => {
    const w = await world();
    const j = await join(w, 'editor');
    await j.call('POST', '/api/contacts', { name: 'Trail Person', phone: '+237677111222', consent: true });
    await j.call('GET', '/api/contacts'); // reads are not recorded
    await j.call('DELETE', `/api/surveys/${w.surveyId}`); // refused
    await j.call('DELETE', `/api/surveys/${w.surveyId}`); // refused again within the minute
    const rows = await prisma.auditLog.findMany({ where: { userId: w.owner.userId, actorId: j.member.userId }, orderBy: { at: 'asc' } });
    expect(rows.filter((r) => r.action === 'member_request').map((r) => r.meta)).toEqual([
      expect.objectContaining({ method: 'POST', route: '/api/contacts', status: 201, role: 'editor' }),
    ]);
    expect(rows.filter((r) => r.action === 'member_denied')).toHaveLength(1);
    const trail = await w.owner.get('/api/team/activity');
    expect(trail.items.map((i: { action: string; who: string }) => [i.action, i.who])).toEqual(expect.arrayContaining([['member_request', 'Jean-Paul'], ['member_denied', 'Jean-Paul'], ['team_member_joined', 'Jean-Paul']]));
    const own = await w.owner.get('/api/auth/activity');
    expect(own.items.map((i: { action: string }) => i.action)).not.toContain('member_request');
    expect(own.items.map((i: { action: string }) => i.action)).not.toContain('team_member_joined');
  });
});

describe('removing, changing and leaving act at the very next request', () => {
  it('a removed member is out at once (and told), a role change applies at once, a member can leave, and the owner can revoke an invitation', async () => {
    const w = await world();
    const j = await join(w, 'editor');
    expect((await j.call('POST', `/api/surveys/${w.surveyId}/send`, { all: true, acceptMarketingCost: true })).status).toBe(200);
    await confirm(w.owner);
    const row = (await w.owner.get('/api/team')).members[0];
    const changed = await app.inject({ method: 'PATCH', url: `/api/team/members/${row.id}`, headers: { authorization: `Bearer ${w.owner.token}`, 'content-type': 'application/json' }, payload: JSON.stringify({ role: 'viewer' }) });
    expect(changed.statusCode).toBe(200);
    expect((await j.call('POST', '/api/contacts', { name: 'X', phone: '+237677000009', consent: true })).json.error).toBe('forbidden_role');
    expect((await j.call('GET', '/api/surveys')).status).toBe(200); // still a viewer
    expect((await w.owner.del(`/api/team/members/${row.id}`)).status).toBe(204);
    expect((await j.call('GET', '/api/surveys')).json.error).toBe('not_a_member');
    expect((await readMockMailbox(j.email)).filter((m) => m.kind === 'team_removed')).toHaveLength(1);
    // leaving by themselves
    const k = await join(w, 'viewer');
    expect((await k.member.post('/api/team/leave', { workspaceId: w.owner.userId })).status).toBe(204);
    expect((await k.call('GET', '/api/surveys')).json.error).toBe('not_a_member');
    expect((await k.member.post('/api/team/leave', { workspaceId: w.owner.userId })).status).toBe(404);
    // revoking an invitation
    await w.owner.post('/api/team/invites', { email: 'later@example.com', role: 'viewer' });
    const inv = (await w.owner.get('/api/team')).invites[0];
    expect((await w.owner.del(`/api/team/invites/${inv.id}`)).status).toBe(204);
    expect((await w.owner.get('/api/team')).invites).toEqual([]);
  });

  it('one owner cannot change or remove another owner\'s member', async () => {
    const a = await world();
    const b = await world();
    const j = await join(a, 'editor');
    const row = (await a.owner.get('/api/team')).members[0];
    await confirm(b.owner);
    expect((await b.owner.del(`/api/team/members/${row.id}`)).status).toBe(404);
    const patch = await app.inject({ method: 'PATCH', url: `/api/team/members/${row.id}`, headers: { authorization: `Bearer ${b.owner.token}`, 'content-type': 'application/json' }, payload: JSON.stringify({ role: 'viewer' }) });
    expect(patch.statusCode).toBe(404);
    expect((await j.call('GET', '/api/contacts')).status).toBe(200);
  });
});

describe('a workspace that is being erased only reads, for everybody in it', () => {
  it('a member\'s changes are refused with 423 while the owner\'s account is scheduled for deletion; reading still works', async () => {
    const w = await buildWorld(app, { contacts: 1, send: false, plan: 'growth' });
    const j = await join(w, 'editor');
    await confirm(w.owner);
    expect((await w.owner.raw('POST', '/api/account/delete', { confirm: 'DELETE' })).status).toBe(200);
    expect((await j.call('GET', '/api/contacts')).status).toBe(200);
    const r = await j.call('POST', '/api/contacts', { name: 'X', phone: '+237677000010', consent: true });
    expect([r.status, r.json.error]).toEqual([423, 'account_pending_deletion']);
  });
});

describe('deny by default, proven over every route of the API', () => {
  const fill = (url: string) => url.replace(/:[A-Za-z]+/g, 'x');
  const routes = () => [...new Set(inventory)].sort().map((k) => { const [method, url] = k.split(' ') as [string, string]; return { key: k, method, url }; });

  it('every route that is not in the member table refuses a member, whatever it does: the only way in is to be listed', async () => {
    const w = await world();
    const j = await join(w, 'editor');
    const checked: string[] = [];
    for (const r of routes()) {
      if (MEMBER_ROUTES[r.key]) continue;
      const anonymous = await app.inject({ method: r.method as never, url: fill(r.url) });
      if (!(anonymous.statusCode === 401 && JSON.parse(anonymous.body || '{}').error === 'unauthorized')) continue; // a public route (a webhook with its own signature, sign-in, prices, health): it does not ask for a login
      const res = await j.call(r.method, fill(r.url), r.method === 'GET' ? undefined : {});
      expect([res.status, res.json?.error], r.key).toEqual([403, 'forbidden_role']);
      checked.push(r.key);
    }
    expect(checked.length).toBeGreaterThan(60);
  });

  it('the table lists only routes that exist, a viewer reaches exactly the viewer routes, and every viewer route only reads', async () => {
    const existing = new Set(inventory);
    expect(Object.keys(MEMBER_ROUTES).filter((k) => !existing.has(k)), 'MEMBER_ROUTES lists routes that no longer exist: remove them').toEqual([]);
    for (const [key, role] of Object.entries(MEMBER_ROUTES)) if (role === 'viewer') expect(key.startsWith('GET '), key).toBe(true);
    const w = await world();
    const v = await join(w, 'viewer');
    for (const [key, role] of Object.entries(MEMBER_ROUTES)) {
      const [method, url] = key.split(' ') as [string, string];
      const res = await v.call(method, fill(url).replace('/x', `/${w.surveyId}`), method === 'GET' ? undefined : {});
      if (role === 'editor') expect([res.status, res.json?.error], key).toEqual([403, 'forbidden_role']);
      else expect(res.status, key).not.toBe(403);
    }
  });
});
