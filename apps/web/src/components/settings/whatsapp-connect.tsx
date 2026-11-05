'use client';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { AlertTriangle, CheckCircle2, Clock, Copy, Facebook, PlugZap, RefreshCw, Smartphone, Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { NUMBER_SITUATIONS, disconnectExplanation, parseSignupEvent, signupLaunchOptions, situationCheck, type NumberSituation, type SignupSession } from '@surveyflow/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { ApiError, api, errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';

interface Config { mode: 'mock' | 'live'; graphVersion: string; embeddedSignup: { appId: string; configId: string; version: string } | null; webhookUrl: string }
interface Account {
  id: string; wabaId: string; phoneNumberId: string; displayPhone: string | null; status: string;
  mode: 'cloud' | 'coexistence'; declaredSituation: NumberSituation | null; signupVersion: string | null; registered: boolean;
  sync: { state: 'none' | 'pending' | 'partial' | 'done' | 'declined' | 'failed'; contacts: number; historyProgress: number | null; historyThreads: number };
  lastAppActivityAt: string | null; pendingAppContacts: number;
  disconnect: { reason: string | null; by: string | null; at: string | null } | null;
  templates: Array<{ name: string; language: string; status: string; reason: string | null }>;
}
interface Accounts { items: Account[] }

declare global { interface Window { FB?: any; fbAsyncInit?: () => void } }

/** Meta's own origin check, as in its implementation guide: only facebook.com may speak to us. */
const fromFacebook = (origin: string) => { try { return /(^|\.)facebook\.com$/.test(new URL(origin).hostname); } catch { return false; } };

function EmbeddedSignup({ cfg, situation, onDone }: { cfg: NonNullable<Config['embeddedSignup']> & { graphVersion: string }; situation: NumberSituation | null; onDone: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const session = useRef<SignupSession | null>(null);

  useEffect(() => {
    // Meta posts the chosen account / phone ids (and whether the number is in the WhatsApp Business app) from the popup via postMessage.
    const onMsg = (e: MessageEvent) => {
      if (!fromFacebook(e.origin)) return;
      const ev = parseSignupEvent(e.data);
      if (!ev) return;
      if (ev.kind === 'finish') session.current = ev.session;
      else if (ev.kind === 'error') toast.error(t('wc.signupError'));
    };
    window.addEventListener('message', onMsg);
    if (!document.getElementById('fb-sdk')) {
      window.fbAsyncInit = () => window.FB.init({ appId: cfg.appId, autoLogAppEvents: true, xfbml: false, version: cfg.graphVersion });
      const s = Object.assign(document.createElement('script'), { id: 'fb-sdk', async: true, defer: true, crossOrigin: 'anonymous', src: 'https://connect.facebook.net/en_US/sdk.js' });
      document.body.appendChild(s);
    }
    return () => window.removeEventListener('message', onMsg);
  }, [cfg.appId, cfg.graphVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  function launch() {
    if (!window.FB) return toast.error(t('w.sdkLoading'));
    setBusy(true);
    session.current = null;
    window.FB.login(
      async (resp: { authResponse?: { code?: string } }) => {
        const code = resp.authResponse?.code;
        // the `message` event can arrive just after the login callback: wait for it, up to five seconds
        for (let i = 0; i < 25 && !session.current; i++) await new Promise((r) => setTimeout(r, 200));
        const s = session.current;
        if (!code || !s) { setBusy(false); return toast.error(t('w.signupCancelled')); }
        try {
          await api('/whatsapp/embedded-signup', { body: { code, wabaId: s.wabaId, phoneNumberId: s.phoneNumberId, isOnBizApp: s.isOnBizApp, declared: situation } });
          toast.success(t('w.connected'));
          onDone();
        } catch (err) {
          toast.error(errorMessage(err, t));
        } finally {
          setBusy(false);
        }
      },
      signupLaunchOptions(cfg.configId),
    );
  }
  return <Button size="lg" onClick={launch} loading={busy} disabled={!situation} className="h-12 bg-[#1877F2] text-white hover:bg-[#1666d4]"><Facebook className="h-5 w-5" aria-hidden />{t('w.embedded')}</Button>;
}

/** The question before the Connect button (D-19): where is the number today? It explains and warns; WhatsApp decides the flow and we read the real answer afterwards. */
function SituationPicker({ value, onChange }: { value: NumberSituation | null; onChange: (v: NumberSituation) => void }) {
  const t = useT();
  const label: Record<NumberSituation, [Parameters<typeof t>[0], Parameters<typeof t>[0]]> = { new: ['wc.q.new', 'wc.q.newHelp'], business_app: ['wc.q.app', 'wc.q.appHelp'], personal_app: ['wc.q.personal', 'wc.q.personalHelp'] };
  return (
    <fieldset className="flex flex-col gap-3" data-testid="situation">
      <legend className="font-display text-lg font-bold">{t('wc.q.title')}</legend>
      <p className="text-sm text-muted-foreground">{t('wc.q.sub')}</p>
      <RadioGroup value={value ?? ''} onValueChange={(v) => onChange(v as NumberSituation)} aria-label={t('wc.q.title')}>
        {NUMBER_SITUATIONS.map((s) => (
          <label key={s} htmlFor={`sit-${s}`} className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 has-[[data-state=checked]]:border-leaf has-[[data-state=checked]]:bg-mint/40">
            <RadioGroupItem value={s} id={`sit-${s}`} data-testid={`situation-${s}`} className="mt-0.5" />
            <span className="flex flex-col gap-0.5"><span className="font-semibold">{t(label[s][0])}</span><span className="text-sm text-muted-foreground">{t(label[s][1])}</span></span>
          </label>
        ))}
      </RadioGroup>
      {value === 'business_app' && (
        <div className="rounded-xl bg-amber-soft p-4 text-sm text-amber-ink" data-testid="app-limits">
          <p className="mb-2 font-bold">{t('wc.app.limitsTitle')}</p>
          <ul className="list-disc space-y-1 pl-5">{(['wc.app.l1', 'wc.app.l2', 'wc.app.l3', 'wc.app.l4', 'wc.app.l5'] as const).map((k) => <li key={k}>{t(k)}</li>)}</ul>
        </div>
      )}
      {!value && <p className="text-sm text-muted-foreground">{t('wc.pick')}</p>}
    </fieldset>
  );
}

export function WhatsAppConnect({ compact = false, onConnected }: { compact?: boolean; onConnected?: () => void }) {
  const t = useT();
  const locale = useLocale();
  const { data: cfg } = useSWR<Config>('/whatsapp/config');
  const { data, mutate } = useSWR<Accounts>('/whatsapp/accounts', { refreshInterval: (latest) => (latest?.items?.[0] && ['pending', 'partial'].includes(latest.items[0].sync.state) ? 5000 : 0) });
  const [manualOpen, setManualOpen] = useState(false);
  const [form, setForm] = useState({ wabaId: '', phoneNumberId: '', accessToken: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [situation, setSituation] = useState<NumberSituation | null>(null);
  const [attest, setAttest] = useState(false);

  if (!cfg || !data) return <Skeleton className="h-40" />;
  const acct = data.items[0];
  const done = async () => { await mutate(); onConnected?.(); };

  async function manual(e: React.FormEvent) {
    e.preventDefault();
    setBusy('manual');
    setError(null);
    try {
      await api('/whatsapp/accounts', { body: form });
      setManualOpen(false);
      setForm({ wabaId: '', phoneNumberId: '', accessToken: '' });
      toast.success(t('w.connected'));
      await done();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'whatsapp_rejected' ? err.message : errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  }
  async function mock(scenario: 'new' | 'business_app') {
    setBusy(`mock-${scenario}`);
    try { await api('/whatsapp/accounts/mock', { method: 'POST', body: { scenario, declared: situation } }); toast.success(t('w.connected')); await done(); }
    catch (err) { toast.error(errorMessage(err, t)); }
    finally { setBusy(null); }
  }
  async function post(path: string, key: string, body?: unknown) {
    setBusy(key);
    try { await api(path, { method: 'POST', body }); await mutate(); }
    catch (err) { toast.error(errorMessage(err, t)); }
    finally { setBusy(null); }
  }
  async function disconnect() {
    if (!window.confirm(t('w.disconnectConfirm'))) return;
    setBusy('del');
    try { await api(`/whatsapp/accounts/${acct!.id}`, { method: 'DELETE' }); await mutate(); }
    catch (err) { toast.error(errorMessage(err, t)); }
    finally { setBusy(null); }
  }
  async function confirmContacts() {
    setBusy('confirm');
    try { const r = await api<{ confirmed: number }>('/whatsapp/app-contacts/confirm', { body: { consent: true } }); toast.success(t('wc.contacts.done', { n: r.confirmed })); setAttest(false); await mutate(); }
    catch (err) { toast.error(errorMessage(err, t)); }
    finally { setBusy(null); }
  }

  const connectPanel = (
    <div className="flex flex-col gap-4">
      <SituationPicker value={situation} onChange={setSituation} />
      <div className="flex flex-wrap gap-3">
        {cfg.embeddedSignup && <EmbeddedSignup cfg={{ ...cfg.embeddedSignup, graphVersion: cfg.graphVersion }} situation={situation} onDone={done} />}
        <Button size="lg" variant="outline" className="h-12" onClick={() => setManualOpen(true)}><PlugZap className="h-5 w-5" aria-hidden />{t('w.manual')}</Button>
        {cfg.mode === 'mock' && (
          <>
            <Button size="lg" variant="brand" className="h-12" disabled={!situation} loading={busy === 'mock-new'} onClick={() => mock('new')} data-testid="sim-new"><Smartphone className="h-5 w-5" aria-hidden />{t('wc.sim.new')}</Button>
            <Button size="lg" variant="brand" className="h-12" disabled={!situation} loading={busy === 'mock-business_app'} onClick={() => mock('business_app')} data-testid="sim-app"><Smartphone className="h-5 w-5" aria-hidden />{t('wc.sim.app')}</Button>
          </>
        )}
      </div>
      {cfg.mode === 'mock' && <p className="rounded-xl bg-amber-soft p-3 text-sm text-amber-ink">{t('w.mockNote')}</p>}
      {!cfg.embeddedSignup && cfg.mode === 'live' && <p className="text-sm text-muted-foreground">{t('w.noEmbedded')}</p>}

      <Dialog open={manualOpen} onOpenChange={setManualOpen}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader><DialogTitle>{t('w.manual')}</DialogTitle><DialogDescription>{t('w.manualHelp')}</DialogDescription></DialogHeader>
          <form onSubmit={manual} className="grid gap-4">
            <Field label="WhatsApp Business Account ID" htmlFor="waba"><Input id="waba" required value={form.wabaId} onChange={(e) => setForm({ ...form, wabaId: e.target.value })} autoComplete="off" /></Field>
            <Field label="Phone number ID" htmlFor="pnid"><Input id="pnid" required value={form.phoneNumberId} onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })} autoComplete="off" /></Field>
            <Field label="Access token" htmlFor="tok" hint={t('w.tokenHint')}><Input id="tok" type="password" required value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value })} autoComplete="off" /></Field>
            {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
            <DialogFooter><Button variant="outline" type="button" onClick={() => setManualOpen(false)}>{t('common.cancel')}</Button><Button type="submit" loading={busy === 'manual'}>{t('w.connect')}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );

  if (!acct) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-body">{t(cfg.embeddedSignup ? 'w.intro' : 'w.introManual')}</p>
        {connectPanel}
      </div>
    );
  }

  const icon = (s: string) => s === 'APPROVED' ? <CheckCircle2 className="h-4 w-4 text-leaf" aria-hidden /> : s === 'REJECTED' || s === 'PAUSED' ? <XCircle className="h-4 w-4 text-destructive" aria-hidden /> : <Clock className="h-4 w-4 text-amber" aria-hidden />;
  const coex = acct.mode === 'coexistence';
  const check = situationCheck(acct.declaredSituation, coex);
  const disc = acct.status === 'disconnected' ? disconnectExplanation(acct.disconnect?.reason, acct.disconnect?.by, locale === 'fr' ? 'fr' : 'en') : null;
  const sync = acct.sync;
  const syncText = sync.state === 'pending' ? t('wc.sync.pending')
    : sync.state === 'partial' ? t('wc.sync.partial', { n: sync.contacts, p: sync.historyProgress ?? 0 })
    : sync.state === 'done' ? t('wc.sync.done', { n: sync.contacts })
    : sync.state === 'declined' ? t('wc.sync.declined', { n: sync.contacts })
    : sync.state === 'failed' ? t('wc.sync.failed') : '';

  return (
    <div className="flex flex-col gap-5">
      {disc && (
        <div role="alert" className="flex flex-col gap-3 rounded-2xl border border-destructive/40 bg-destructive/5 p-4" data-testid="disconnected-banner">
          <p className="flex items-center gap-2 font-bold text-destructive"><AlertTriangle className="h-5 w-5" aria-hidden />{t('wc.disc.title')}</p>
          <p className="text-sm">{disc.why}</p>
          <p className="text-sm text-muted-foreground">{t('wc.disc.paused')} {disc.fix}</p>
          <p className="font-semibold">{t('wc.disc.reconnect')}</p>
          {connectPanel}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-mint/50 p-4">
        <Smartphone className="h-6 w-6 text-leaf" aria-hidden />
        <div className="flex-1">
          <p className="font-bold">{acct.displayPhone || acct.phoneNumberId}</p>
          <p className="text-xs text-muted-foreground">WABA {acct.wabaId} · <span data-testid="mode">{t(coex ? 'wc.mode.coexistence' : 'wc.mode.cloud')}</span></p>
          {coex && acct.lastAppActivityAt && <p className="text-xs text-muted-foreground">{t('wc.app.used', { date: dateTime(acct.lastAppActivityAt, locale) })}</p>}
        </div>
        <Badge variant={acct.status === 'active' ? 'brand' : 'danger'}>{acct.status === 'active' ? t('w.active') : t('w.error')}</Badge>
        <Button size="sm" variant="outline" onClick={disconnect} loading={busy === 'del'}><Trash2 className="h-4 w-4" aria-hidden />{t('w.disconnect')}</Button>
      </div>

      {check === 'said_new_but_in_app' && <p className="rounded-xl bg-amber-soft p-3 text-sm text-amber-ink" role="status" data-testid="mismatch">{t('wc.mismatch.newButApp')}</p>}
      {check === 'said_app_but_not' && <p className="rounded-xl bg-amber-soft p-3 text-sm text-amber-ink" role="status" data-testid="mismatch">{t('wc.mismatch.appButNot')}</p>}

      {acct.mode === 'cloud' && acct.signupVersion && !acct.registered && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-amber-soft p-3 text-sm text-amber-ink" role="status" data-testid="register-failed">
          <span className="flex-1">{t('wc.reg.failed')}</span>
          <Button size="sm" variant="outline" loading={busy === 'reg'} onClick={() => post(`/whatsapp/accounts/${acct.id}/register`, 'reg')}>{t('wc.reg.retry')}</Button>
        </div>
      )}

      {coex && sync.state !== 'none' && (
        <div className="flex flex-col gap-2 rounded-2xl border border-line p-4 text-sm" data-testid="sync">
          <p className="font-semibold">{t('wc.sync.title')}</p>
          <p data-testid="sync-text">{syncText}</p>
          {(sync.state === 'pending' || sync.state === 'partial') && <p className="text-muted-foreground">{t('wc.sync.keepOpen')}</p>}
          {sync.state === 'failed' && <div><Button size="sm" variant="outline" loading={busy === 'sync'} onClick={() => post(`/whatsapp/accounts/${acct.id}/sync`, 'sync')}>{t('wc.sync.retry')}</Button></div>}
        </div>
      )}

      {coex && acct.pendingAppContacts > 0 && (
        <div className="flex flex-col gap-3 rounded-2xl border border-line p-4 text-sm" data-testid="app-contacts">
          <p>{t('wc.contacts.pending', { n: acct.pendingAppContacts })}</p>
          <label className="flex items-start gap-3 font-semibold"><Checkbox checked={attest} onCheckedChange={(v) => setAttest(!!v)} data-testid="attest" className="mt-0.5" />{t('wc.contacts.confirmLabel')}</label>
          <div><Button size="sm" disabled={!attest} loading={busy === 'confirm'} onClick={confirmContacts} data-testid="confirm-contacts">{t('wc.contacts.confirmBtn', { n: acct.pendingAppContacts })}</Button></div>
        </div>
      )}

      {!compact && (
        <>
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="font-display text-lg font-bold">{t('w.templates')}</h3><Button size="sm" variant="outline" onClick={() => post(`/whatsapp/accounts/${acct.id}/templates/sync`, 'sync-tpl')} loading={busy === 'sync-tpl'}><RefreshCw className="h-4 w-4" aria-hidden />{t('w.refresh')}</Button></div>
            <p className="mb-3 text-sm text-muted-foreground">{t('w.templatesHelp')}</p>
            <Table>
              <THead><tr><TH>{t('common.name')}</TH><TH>{t('w.lang')}</TH><TH>{t('common.status')}</TH></tr></THead>
              <TBody>{acct.templates.map((x) => <TR key={x.name + x.language}><TD className="font-mono text-xs">{x.name}</TD><TD>{x.language.toUpperCase()}</TD><TD><span className="flex items-center gap-2">{icon(x.status)}{x.status}{x.reason && <span className="text-xs text-muted-foreground">({x.reason})</span>}</span></TD></TR>)}</TBody>
            </Table>
          </div>
          {cfg.mode === 'live' && (
            <div className="rounded-2xl border border-line p-4 text-sm">
              <p className="mb-2 font-semibold">{t('w.webhook')}</p>
              <p className="mb-2 text-muted-foreground">{t('w.webhookHelp')}</p>
              <div className="flex items-center gap-2"><code className="flex-1 overflow-x-auto rounded-lg bg-canvas px-3 py-2 text-xs">{cfg.webhookUrl}</code><Button size="sm" variant="outline" aria-label={t('common.copy')} onClick={() => { void navigator.clipboard?.writeText(cfg.webhookUrl); }}><Copy className="h-4 w-4" aria-hidden /></Button></div>
            </div>
          )}
          {cfg.mode === 'mock' && coex && (
            <div className="rounded-2xl border border-dashed border-line p-4 text-sm" data-testid="mock-events">
              <p className="mb-2 font-semibold">{t('wc.sim.panel')}</p>
              <div className="flex flex-wrap gap-2">
                {([['contacts', 'wc.sim.contacts'], ['history', 'wc.sim.history'], ['echo', 'wc.sim.echo'], ['disconnect', 'wc.sim.disconnect'], ['reconnect', 'wc.sim.reconnect']] as const).map(([ev, k]) => (
                  <Button key={ev} size="sm" variant="outline" loading={busy === `ev-${ev}`} data-testid={`mock-${ev}`} onClick={() => post(`/whatsapp/accounts/${acct.id}/mock-event`, `ev-${ev}`, { event: ev })}>{t(k)}</Button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
