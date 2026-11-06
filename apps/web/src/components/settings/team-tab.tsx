'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { LogOut, Trash2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useAccount } from '@/lib/account';
import { ApiError, api, errorMessage } from '@/lib/api';
import { dateShort, dateTime } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';
import { currentWorkspace, setWorkspace } from '@/lib/workspace';

type Role = 'viewer' | 'editor';
interface Team { seats: number; members: Array<{ id: string; name: string; email: string; role: Role; since: string; twoFactor: boolean }>; invites: Array<{ id: string; email: string; role: Role; expiresAt: string }> }
interface Trail { items: Array<{ id: string; at: string; action: string; who: string; email: string | null; meta: { method?: string; route?: string; status?: number } | null }> }
interface Workspaces { items: Array<{ workspaceId: string; businessName: string; role: Role }> }

/** Settings, Team (BIZ-04): your colleagues and what they can do; the teams you work in; what your team did. */
export function TeamTab() {
  const t = useT();
  const { account } = useAccount();
  const inWorkspace = !!account?.member;
  const { data: mine, mutate: refreshMine } = useSWR<Workspaces>('/team/workspaces');
  return (
    <div className="grid max-w-3xl gap-6">
      {!inWorkspace && <OwnerTeam />}
      <Card>
        <CardHeader><CardTitle>{t('tm.mineTitle')}</CardTitle><CardDescription>{t('tm.mineText')}</CardDescription></CardHeader>
        <CardContent className="grid gap-3">
          {!mine ? <Skeleton className="h-16" /> : mine.items.length === 0 ? <p className="text-sm text-muted-foreground">{t('tm.mineNone')}</p> : mine.items.map((w) => {
            const here = currentWorkspace() === w.workspaceId;
            return (
              <div key={w.workspaceId} className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3 text-sm" data-testid="workspace-row">
                <span className="flex-1 font-semibold">{w.businessName}</span>
                <Badge variant="neutral">{t(`tm.role.${w.role}`)}</Badge>
                {here ? <Badge>{t('tm.here')}</Badge> : <Button size="sm" onClick={() => { setWorkspace(w.workspaceId); window.location.assign('/dashboard'); }}>{t('tm.open')}</Button>}
                <Button size="sm" variant="outline" onClick={async () => {
                  try { await api('/team/leave', { method: 'POST', body: { workspaceId: w.workspaceId } }); if (here) setWorkspace(null); await refreshMine(); if (here) window.location.assign('/dashboard'); }
                  catch (err) { toast.error(errorMessage(err, t)); }
                }}><LogOut className="h-4 w-4" aria-hidden />{t('tm.leave')}</Button>
              </div>
            );
          })}
          {inWorkspace && <div><Button variant="dark" onClick={() => { setWorkspace(null); window.location.assign('/dashboard'); }}>{t('tm.back')}</Button></div>}
        </CardContent>
      </Card>
    </div>
  );
}

function OwnerTeam() {
  const t = useT();
  const locale = useLocale();
  const { data, mutate } = useSWR<Team>('/team');
  const { data: trail } = useSWR<Trail>('/team/activity');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [busy, setBusy] = useState(false);
  if (!data) return <Skeleton className="h-64" />;
  const others = Math.max(0, data.seats - 1);
  const used = data.members.length + data.invites.length;

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try { await api('/team/invites', { method: 'POST', body: { email: email.trim(), role } }); setEmail(''); await mutate(); toast.success(t('tm.invited')); }
    catch (err) { toast.error(err instanceof ApiError && err.code === 'plan_limit' ? t('tm.planLimit', { seats: data!.seats }) : errorMessage(err, t)); }
    finally { setBusy(false); }
  }
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await mutate(); } catch (err) { toast.error(errorMessage(err, t)); } };

  return (
    <>
      <Card>
        <CardHeader><CardTitle>{t('tm.title')}</CardTitle><CardDescription>{t('tm.text', { seats: data.seats })}</CardDescription></CardHeader>
        <CardContent className="grid gap-5">
          <ul className="grid gap-1.5 rounded-xl bg-canvas p-4 text-sm text-body">
            <li><strong>{t('tm.role.viewer')}</strong>: {t('tm.roleViewerText')}</li>
            <li><strong>{t('tm.role.editor')}</strong>: {t('tm.roleEditorText')}</li>
            <li className="text-muted-foreground">{t('tm.never')}</li>
          </ul>
          {others === 0 ? <p className="rounded-xl bg-amber-soft p-4 text-sm text-amber-ink" data-testid="tm-no-seats">{t('tm.noSeats')}</p> : (
            <form onSubmit={invite} className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
              <Field label={t('tm.email')} htmlFor="tm-email"><Input id="tm-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" /></Field>
              <Field label={t('tm.roleLabel')} htmlFor="tm-role">
                <Select value={role} onValueChange={(v) => setRole(v as Role)}>
                  <SelectTrigger id="tm-role" className="min-w-[140px]"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="viewer">{t('tm.role.viewer')}</SelectItem><SelectItem value="editor">{t('tm.role.editor')}</SelectItem></SelectContent>
                </Select>
              </Field>
              <Button type="submit" loading={busy} disabled={used >= others} data-testid="tm-invite"><UserPlus className="h-4 w-4" aria-hidden />{t('tm.invite')}</Button>
            </form>
          )}
          <p className="text-xs text-muted-foreground">{t('tm.seatsUsed', { used: used + 1, seats: data.seats })}</p>

          {data.members.length > 0 && (
            <div className="grid gap-2" data-testid="tm-members">
              {data.members.map((m) => (
                <div key={m.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3 text-sm">
                  <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{m.name}</span><span className="block truncate text-muted-foreground">{m.email}</span></span>
                  {!m.twoFactor && <Badge variant="warn">{t('tm.no2fa')}</Badge>}
                  <Select value={m.role} onValueChange={(v) => void act(() => api(`/team/members/${m.id}`, { method: 'PATCH', body: { role: v } }))}>
                    <SelectTrigger className="w-[130px]" aria-label={t('tm.roleLabel')}><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="viewer">{t('tm.role.viewer')}</SelectItem><SelectItem value="editor">{t('tm.role.editor')}</SelectItem></SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" aria-label={t('tm.remove')} onClick={() => void act(() => api(`/team/members/${m.id}`, { method: 'DELETE' }))}><Trash2 className="h-4 w-4" aria-hidden />{t('tm.remove')}</Button>
                </div>
              ))}
            </div>
          )}
          {data.invites.length > 0 && (
            <div className="grid gap-2" data-testid="tm-invites">
              {data.invites.map((i) => (
                <div key={i.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-line p-3 text-sm">
                  <span className="min-w-0 flex-1 truncate">{i.email}</span>
                  <Badge variant="neutral">{t(`tm.role.${i.role}`)}</Badge>
                  <span className="text-muted-foreground">{t('tm.expires', { date: dateShort(i.expiresAt, locale) })}</span>
                  <Button size="sm" variant="outline" onClick={() => void act(() => api(`/team/invites/${i.id}`, { method: 'DELETE' }))}>{t('tm.revoke')}</Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('tm.trailTitle')}</CardTitle><CardDescription>{t('tm.trailText')}</CardDescription></CardHeader>
        <CardContent>
          {!trail ? <Skeleton className="h-24" /> : trail.items.length === 0 ? <p className="text-sm text-muted-foreground">{t('tm.trailNone')}</p> : (
            <ul className="divide-y divide-line text-sm" data-testid="tm-trail">
              {trail.items.map((i) => (
                <li key={i.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
                  <span className="w-40 shrink-0 text-muted-foreground">{dateTime(i.at, locale)}</span>
                  <span className="font-semibold">{i.who}</span>
                  <span>{t(`tm.act.${i.action}` as 'tm.act.member_request')}</span>
                  {i.meta?.route && <code className="text-xs text-muted-foreground">{i.meta.method} {i.meta.route.replace('/api/', '')}{i.meta.status ? ` → ${i.meta.status}` : ''}</code>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
