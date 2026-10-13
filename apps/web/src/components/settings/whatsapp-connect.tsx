'use client';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { CheckCircle2, Clock, Copy, Facebook, PlugZap, RefreshCw, Smartphone, Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useT } from '@/lib/i18n/client';

interface Config { mode: 'mock' | 'live'; graphVersion: string; embeddedSignup: { appId: string; configId: string } | null; webhookUrl: string }
interface Accounts { items: Array<{ id: string; wabaId: string; phoneNumberId: string; displayPhone: string | null; status: string; templates: Array<{ name: string; language: string; status: string; reason: string | null }> }> }

declare global { interface Window { FB?: any; fbAsyncInit?: () => void } }

function EmbeddedSignup({ cfg, onDone }: { cfg: NonNullable<Config['embeddedSignup']> & { graphVersion: string }; onDone: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const session = useRef<{ waba_id?: string; phone_number_id?: string } | null>(null);

  useEffect(() => {
    // Meta posts the chosen WABA / phone ids from the popup via postMessage.
    const onMsg = (e: MessageEvent) => {
      if (!/facebook\.com$/.test(new URL(e.origin).hostname)) return;
      try {
        const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (d?.type === 'WA_EMBEDDED_SIGNUP' && d.event === 'FINISH') session.current = d.data;
      } catch { /* not ours */ }
    };
    window.addEventListener('message', onMsg);
    if (!document.getElementById('fb-sdk')) {
      window.fbAsyncInit = () => window.FB.init({ appId: cfg.appId, autoLogAppEvents: true, xfbml: false, version: cfg.graphVersion });
      const s = Object.assign(document.createElement('script'), { id: 'fb-sdk', async: true, defer: true, crossOrigin: 'anonymous', src: 'https://connect.facebook.net/en_US/sdk.js' });
      document.body.appendChild(s);
    }
    return () => window.removeEventListener('message', onMsg);
  }, [cfg.appId, cfg.graphVersion]);

  function launch() {
    if (!window.FB) return toast.error(t('w.sdkLoading'));
    setBusy(true);
    window.FB.login(
      async (resp: { authResponse?: { code?: string } }) => {
        const code = resp.authResponse?.code;
        // the `message` event can arrive just after the login callback
        await new Promise((r) => setTimeout(r, 800));
        if (!code || !session.current?.waba_id || !session.current?.phone_number_id) { setBusy(false); return toast.error(t('w.signupCancelled')); }
        try {
          await api('/whatsapp/embedded-signup', { body: { code, wabaId: session.current.waba_id, phoneNumberId: session.current.phone_number_id } });
          toast.success(t('w.connected'));
          onDone();
        } catch (err) {
          toast.error(errorMessage(err, t));
        } finally {
          setBusy(false);
        }
      },
      { config_id: cfg.configId, response_type: 'code', override_default_response_type: true, extras: { setup: {}, sessionInfoVersion: '3' } },
    );
  }
  return <Button size="lg" onClick={launch} loading={busy} className="h-12 bg-[#1877F2] text-white hover:bg-[#1666d4]"><Facebook className="h-5 w-5" aria-hidden />{t('w.embedded')}</Button>;
}

export function WhatsAppConnect({ compact = false, onConnected }: { compact?: boolean; onConnected?: () => void }) {
  const t = useT();
  const { data: cfg } = useSWR<Config>('/whatsapp/config');
  const { data, mutate } = useSWR<Accounts>('/whatsapp/accounts');
  const [manualOpen, setManualOpen] = useState(false);
  const [form, setForm] = useState({ wabaId: '', phoneNumberId: '', accessToken: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  async function mock() {
    setBusy('mock');
    try { await api('/whatsapp/accounts/mock', { method: 'POST' }); toast.success(t('w.connected')); await done(); }
    catch (err) { toast.error(errorMessage(err, t)); }
    finally { setBusy(null); }
  }
  async function syncTemplates() {
    setBusy('sync');
    try { await api(`/whatsapp/accounts/${acct!.id}/templates/sync`, { method: 'POST' }); await mutate(); }
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

  if (!acct) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-body">{t('w.intro')}</p>
        <div className="flex flex-wrap gap-3">
          {cfg.embeddedSignup && <EmbeddedSignup cfg={{ ...cfg.embeddedSignup, graphVersion: cfg.graphVersion }} onDone={done} />}
          <Button size="lg" variant="outline" className="h-12" onClick={() => setManualOpen(true)}><PlugZap className="h-5 w-5" aria-hidden />{t('w.manual')}</Button>
          {cfg.mode === 'mock' && <Button size="lg" variant="brand" className="h-12" loading={busy === 'mock'} onClick={mock}><Smartphone className="h-5 w-5" aria-hidden />{t('w.simulated')}</Button>}
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
  }

  const icon = (s: string) => s === 'APPROVED' ? <CheckCircle2 className="h-4 w-4 text-leaf" aria-hidden /> : s === 'REJECTED' || s === 'PAUSED' ? <XCircle className="h-4 w-4 text-destructive" aria-hidden /> : <Clock className="h-4 w-4 text-amber" aria-hidden />;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-mint/50 p-4">
        <Smartphone className="h-6 w-6 text-leaf" aria-hidden />
        <div className="flex-1"><p className="font-bold">{acct.displayPhone || acct.phoneNumberId}</p><p className="text-xs text-muted-foreground">WABA {acct.wabaId}</p></div>
        <Badge variant={acct.status === 'active' ? 'brand' : 'danger'}>{acct.status === 'active' ? t('w.active') : t('w.error')}</Badge>
        <Button size="sm" variant="outline" onClick={disconnect} loading={busy === 'del'}><Trash2 className="h-4 w-4" aria-hidden />{t('w.disconnect')}</Button>
      </div>
      {!compact && (
        <>
          <div>
            <div className="mb-2 flex items-center justify-between"><h3 className="font-display text-lg font-bold">{t('w.templates')}</h3><Button size="sm" variant="outline" onClick={syncTemplates} loading={busy === 'sync'}><RefreshCw className="h-4 w-4" aria-hidden />{t('w.refresh')}</Button></div>
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
              <div className="flex items-center gap-2"><code className="flex-1 overflow-x-auto rounded-lg bg-canvas px-3 py-2 text-xs">{cfg.webhookUrl}</code><Button size="sm" variant="outline" aria-label={t('common.copy')} onClick={() => { void navigator.clipboard.writeText(cfg.webhookUrl); toast.success(t('common.copied')); }}><Copy className="h-4 w-4" aria-hidden /></Button></div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
