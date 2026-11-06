'use client';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Circle, Facebook, Loader2, MessageSquareText, ShieldCheck, Smartphone } from 'lucide-react';
import { demoNumberKind, type NumberSituation, type SignupTraceStep } from '@surveyflow/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAccount } from '@/lib/account';
import type { TKey } from '@/lib/i18n';
import { useT } from '@/lib/i18n/client';

/**
 * The simulated Embedded Signup (DEMO MODE ONLY: the page draws it only when the server runs the mock WhatsApp gateway). A customer meets Meta's popup, not SurveyFlow's own
 * screens, so this plays Meta's documented order (login, access, number, code or QR, business, terms, finish, then billing in Meta) to show what is asked of them, and next to
 * it who receives each answer and what SurveyFlow's code then does with its simulated Meta (the list comes from the connection itself, not from a script).
 * The popup's own text is a stand-in: Meta's screens were not seen (docs/META_CHECK.md).
 */
type Step = 'login' | 'auth' | 'phone' | 'verify' | 'refused' | 'profile' | 'biz' | 'qr' | 'tz' | 'perm' | 'done' | 'working' | 'bill';
const DEMO_CODE = '482913';
const ZONES = ['Africa/Douala', 'Africa/Lagos', 'Africa/Accra', 'Africa/Nairobi', 'Europe/Paris', 'UTC'];
const digitsOf = (v: string) => v.replace(/\D/g, '').replace(/^00/, '');

/** A decorative stand-in for a QR code (not scannable, on purpose). */
function FakeQr() {
  const rects = useMemo(() => {
    const out: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < 21; y++) {
      for (let x = 0; x < 21; x++) {
        const corner = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
        if (corner) {
          const lx = x % 14, ly = y % 14; // position inside the 7x7 finder square
          const ring = lx === 0 || lx === 6 || ly === 0 || ly === 6;
          const core = lx > 1 && lx < 5 && ly > 1 && ly < 5;
          if (ring || core) out.push({ x, y });
        } else if ((x * 7919 + y * 31 + x * y * 17) % 5 < 2) out.push({ x, y });
      }
    }
    return out;
  }, []);
  return (
    <svg viewBox="0 0 21 21" className="mx-auto h-40 w-40 rounded-lg border border-line bg-white p-1" role="img" aria-label="QR code (simulated)">
      {rects.map((r) => <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width="1" height="1" fill="#0b2b22" />)}
    </svg>
  );
}

export function SimulatedSignup({ open, onOpenChange, situation, onFinished }: { open: boolean; onOpenChange: (v: boolean) => void; situation: NumberSituation | null; onFinished: () => void }) {
  const t = useT();
  const { account } = useAccount();
  const [step, setStep] = useState<Step>('login');
  const [reached, setReached] = useState<string[]>([]);
  const [phone, setPhone] = useState('+237 6');
  const [phoneError, setPhoneError] = useState(false);
  const [kind, setKind] = useState<'new' | 'business_app' | 'personal_app'>('new');
  const [code, setCode] = useState('');
  const [codeWrong, setCodeWrong] = useState(false);
  const [voiced, setVoiced] = useState(false);
  const [bizName, setBizName] = useState('');
  const [country, setCountry] = useState('');
  const [site, setSite] = useState('');
  const [zone, setZone] = useState(ZONES[0]!);
  const [terms, setTerms] = useState(false);
  const [trace, setTrace] = useState<SignupTraceStep[] | null>(null);
  const [shown, setShown] = useState(0);
  const [event, setEvent] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paid, setPaid] = useState<null | 'added' | 'later'>(null);
  const connected = !!trace;

  // a fresh run every time the window opens
  useEffect(() => {
    if (!open) return;
    setStep('login'); setReached([]); setPhone('+237 6'); setPhoneError(false); setKind('new'); setCode(''); setCodeWrong(false); setVoiced(false);
    setBizName(account?.user.businessName ?? ''); setCountry(account?.user.country ?? 'CM'); setSite(''); setZone(ZONES[0]!); setTerms(false);
    setTrace(null); setShown(0); setEvent(null); setError(null); setPaid(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // the steps appear one after the other so a person can read them; what they say is what the connection returned
  useEffect(() => {
    if (!trace || shown >= trace.length) return;
    const id = setTimeout(() => setShown((n) => n + 1), 550);
    return () => clearTimeout(id);
  }, [trace, shown]);

  const reach = (k: string) => setReached((r) => (r.includes(k) ? r : [...r, k]));
  const go = (k: string, next: Step) => { reach(k); setStep(next); };
  const phoneShown = phone.trim();

  function submitPhone() {
    const d = digitsOf(phone);
    if (d.length < 8 || d.length > 15) return setPhoneError(true);
    setPhoneError(false);
    const k = demoNumberKind(d);
    setKind(k);
    reach('phone');
    setStep(k === 'personal_app' ? 'refused' : k === 'new' ? 'verify' : 'profile');
  }
  function submitCode() {
    if (code.trim() !== DEMO_CODE) return setCodeWrong(true);
    setCodeWrong(false);
    go('verify', 'biz');
  }
  async function finish() {
    setStep('working'); setError(null); setTrace(null); setShown(0); reach('perm');
    try {
      const r = await api<{ items: Array<{ wabaId: string; phoneNumberId: string }>; trace: SignupTraceStep[] }>('/whatsapp/accounts/mock', { method: 'POST', body: { phone: digitsOf(phone), declared: situation, scenario: kind === 'business_app' ? 'business_app' : 'new' } });
      const a = r.items[0]!;
      setEvent({ type: 'WA_EMBEDDED_SIGNUP', event: kind === 'business_app' ? 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' : 'FINISH', data: { phone_number_id: a.phoneNumberId, is_on_biz_app: kind === 'business_app', messaging_account_ids: [a.wabaId] }, code: '<one-time code>' });
      setTrace(r.trace);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : errorMessage(err, t));
    }
  }
  function close(v: boolean) {
    if (!v && connected) onFinished();
    onOpenChange(v);
  }

  const stepLabel = (s: SignupTraceStep) => (s.key === 'mode' ? t(`ss.t.mode.${s.info === 'coexistence' ? 'coexistence' : 'cloud'}` as TKey) : t(`ss.t.${s.key}` as TKey, { info: s.info ?? '' }));
  // The customer's checklist (right side): plain words, what to give and why, ticked once done. Eight steps for a new number, five for a number in the WhatsApp Business app.
  const plan: 'new' | 'app' = reached.includes('phone') ? (kind === 'business_app' ? 'app' : 'new') : situation === 'business_app' ? 'app' : 'new';
  const doneKeys: Record<string, boolean> = {
    login: reached.includes('login'), auth: reached.includes('auth'), phone: reached.includes('phone'), verify: reached.includes('verify'), biz: reached.includes('biz'), perm: reached.includes('perm'),
    access: reached.includes('auth'), number: reached.includes('biz'), scan: reached.includes('tz'),
    pay: paid === 'added', ready: connected && paid !== null,
  };
  const keys = plan === 'new' ? ['login', 'auth', 'phone', 'verify', 'biz', 'perm', 'pay', 'ready'] : ['access', 'number', 'scan', 'pay', 'ready'];
  const currentKey = keys.find((k) => !doneKeys[k]);
  const itemState = (k: string): 'done' | 'current' | 'attention' | 'todo' => (doneKeys[k] ? 'done' : k === 'pay' && paid === 'later' ? 'attention' : k === currentKey ? 'current' : 'todo');
  const perms = (<ul className="list-disc space-y-1 pl-5 text-sm"><li>{t('ss.auth.p1')}</li><li>{t('ss.auth.p2')}</li>{step === 'perm' && <li>{t('ss.perm.p3')}</li>}</ul>);
  const field = 'h-11';

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent closeLabel={t('ss.close')} className="max-w-5xl p-4 sm:p-6" data-testid="sim-dialog">
        <DialogTitle className="sr-only">{t('ss.open')}</DialogTitle>
        <DialogDescription className="rounded-xl bg-amber-soft p-3 text-sm text-amber-ink" data-testid="sim-banner">{t('ss.banner')}</DialogDescription>
        <div className="grid gap-5 md:grid-cols-[minmax(0,430px)_minmax(0,1fr)]">
          {/* Meta's popup */}
          <div className="overflow-hidden rounded-2xl border border-line shadow-sm" data-testid="sim-window">
            <div className="flex items-center gap-2 border-b border-line bg-canvas px-4 py-2.5 text-xs text-muted-foreground">
              <span className="flex gap-1.5" aria-hidden><i className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" /><i className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" /><i className="h-2.5 w-2.5 rounded-full bg-[#28c840]" /></span>
              <Facebook className="ml-2 h-4 w-4 text-[#1877F2]" aria-hidden /><span>{t('ss.window')}</span>
            </div>
            <div className="flex min-h-[26rem] flex-col gap-4 p-5" data-step={step}>
              {step === 'login' && (<>
                <h3 className="text-xl font-bold">{t('ss.login.title')}</h3><p className="text-sm text-muted-foreground">{t('ss.login.sub')}</p>
                <div className="flex items-center gap-3 rounded-xl border border-line p-3"><span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1877F2] font-bold text-white">{(account?.user.name ?? 'A').slice(0, 1).toUpperCase()}</span><span className="font-semibold">{account?.user.name}</span></div>
                <Button className="h-11 bg-[#1877F2] text-white hover:bg-[#1666d4]" onClick={() => go('login', 'auth')} data-testid="sim-login-btn">{t('ss.login.btn', { name: account?.user.name ?? '' })}</Button>
              </>)}
              {step === 'auth' && (<>
                <h3 className="text-xl font-bold">{t('ss.auth.title')}</h3><p className="text-sm text-muted-foreground">{t('ss.auth.sub')}</p>{perms}
                <Button className="mt-auto h-11 bg-[#1877F2] text-white hover:bg-[#1666d4]" onClick={() => go('auth', 'phone')} data-testid="sim-auth-btn">{t('ss.auth.btn')}</Button>
              </>)}
              {step === 'phone' && (<>
                <h3 className="text-xl font-bold">{t('ss.phone.title')}</h3><p className="text-sm text-muted-foreground">{t('ss.phone.sub')}</p>
                <label className="flex flex-col gap-1 text-sm font-semibold">{t('ss.phone.label')}<Input className={field} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submitPhone()} data-testid="sim-phone" /></label>
                {phoneError && <p role="alert" className="text-sm font-medium text-destructive">{t('ss.phone.invalid')}</p>}
                <p className="rounded-lg bg-canvas p-3 text-xs text-muted-foreground">{t('ss.phone.demo')}</p>
                <Button className="mt-auto h-11 bg-[#1877F2] text-white hover:bg-[#1666d4]" onClick={submitPhone} data-testid="sim-phone-next">{t('ss.next')}</Button>
              </>)}
              {step === 'verify' && (<>
                <h3 className="text-xl font-bold">{t('ss.verify.title')}</h3><p className="text-sm text-muted-foreground">{t('ss.verify.sub', { phone: phoneShown })}</p>
                <div className="flex items-start gap-2 rounded-xl bg-canvas p-3 text-sm" data-testid="sim-sms"><MessageSquareText className="mt-0.5 h-4 w-4 text-leaf" aria-hidden /><span><b>{t('ss.verify.sms')}</b><br />WhatsApp: <b className="tracking-widest">{DEMO_CODE}</b></span></div>
                <label className="flex flex-col gap-1 text-sm font-semibold">{t('ss.verify.label')}<Input className={field} inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submitCode()} data-testid="sim-code" /></label>
                {codeWrong && <p role="alert" className="text-sm font-medium text-destructive">{t('ss.verify.wrong')}</p>}
                <button type="button" className="self-start text-sm underline" onClick={() => setVoiced(true)}>{t('ss.verify.voice')}</button>
                {voiced && <p className="text-xs text-muted-foreground">{t('ss.verify.voiced')}</p>}
                <Button className="mt-auto h-11 bg-[#1877F2] text-white hover:bg-[#1666d4]" onClick={submitCode} data-testid="sim-verify-btn">{t('ss.verify.btn')}</Button>
              </>)}
              {step === 'refused' && (<>
                <h3 className="text-xl font-bold" data-testid="sim-refused">{t('ss.refused.title')}</h3><p className="text-sm">{t('ss.refused.body', { phone: phoneShown })}</p>
                <Button className="mt-auto h-11" variant="outline" onClick={() => { setReached((r) => r.filter((k) => k !== 'phone')); setStep('phone'); }} data-testid="sim-refused-btn">{t('ss.refused.btn')}</Button>
              </>)}
              {step === 'profile' && (<>
                <h3 className="text-xl font-bold">{t('ss.profile.title')}</h3><p className="text-sm text-muted-foreground">{t('ss.profile.sub')}</p>
                <div className="flex items-center gap-3 rounded-xl border border-line p-3"><span className="flex h-12 w-12 items-center justify-center rounded-full bg-mint"><Smartphone className="h-6 w-6 text-leaf" aria-hidden /></span><div className="text-sm"><p className="font-bold">{account?.user.businessName}</p><p className="text-muted-foreground">{phoneShown}</p><p className="text-muted-foreground">{t('ss.profile.site')}: —</p></div></div>
                <Button className="mt-auto h-11 bg-[#1877F2] text-white hover:bg-[#1666d4]" onClick={() => go('profile', 'biz')} data-testid="sim-profile-btn">{t('ss.profile.btn')}</Button>
              </>)}
              {step === 'biz' && (<>
                <h3 className="text-xl font-bold">{t('ss.biz.title')}</h3><p className="text-sm text-muted-foreground">{t('ss.biz.sub')}</p>
                <label className="flex flex-col gap-1 text-sm font-semibold">{t('ss.biz.name')}<Input className={field} value={bizName} onChange={(e) => setBizName(e.target.value)} data-testid="sim-biz-name" /></label>
                <label className="flex flex-col gap-1 text-sm font-semibold">{t('ss.biz.country')}<Input className={field} value={country} onChange={(e) => setCountry(e.target.value)} /></label>
                <label className="flex flex-col gap-1 text-sm font-semibold">{t('ss.biz.site')}<Input className={field} value={site} onChange={(e) => setSite(e.target.value)} /></label>
                <Button className="mt-auto h-11 bg-[#1877F2] text-white hover:bg-[#1666d4]" onClick={() => go('biz', kind === 'new' ? 'perm' : 'qr')} data-testid="sim-biz-next">{t('ss.next')}</Button>
              </>)}
              {step === 'qr' && (<>
                <h3 className="text-xl font-bold">{t('ss.qr.title')}</h3><p className="text-sm text-muted-foreground">{t('ss.qr.sub')}</p>
                <FakeQr /><p className="flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t('ss.qr.waiting')}</p>
                <Button className="mt-auto h-11 bg-[#1877F2] text-white hover:bg-[#1666d4]" onClick={() => go('qr', 'tz')} data-testid="sim-qr-btn">{t('ss.qr.btn')}</Button>
              </>)}
              {step === 'tz' && (<>
                <h3 className="text-xl font-bold">{t('ss.tz.title')}</h3>
                <label className="flex flex-col gap-1 text-sm font-semibold">{t('ss.tz.name')}<Input className={field} readOnly value={account?.user.businessName ?? ''} /></label>
                <label className="flex flex-col gap-1 text-sm font-semibold">{t('ss.tz.zone')}
                  <select className="h-11 rounded-xl border border-input bg-white px-3 text-sm" value={zone} onChange={(e) => setZone(e.target.value)}>{ZONES.map((z) => <option key={z}>{z}</option>)}</select></label>
                <label className="flex items-start gap-3 text-sm font-semibold"><Checkbox checked={terms} onCheckedChange={(v) => setTerms(!!v)} className="mt-0.5" data-testid="sim-tz-terms" />{t('ss.tz.terms')}</label>
                <Button className="mt-auto h-11 bg-[#1877F2] text-white hover:bg-[#1666d4]" disabled={!terms} onClick={() => go('tz', 'done')} data-testid="sim-tz-next">{t('ss.next')}</Button>
              </>)}
              {step === 'perm' && (<>
                <h3 className="text-xl font-bold">{t('ss.perm.title')}</h3><p className="text-sm text-muted-foreground">{t('ss.perm.sub')}</p>{perms}
                <Button className="mt-auto h-11 bg-[#1877F2] text-white hover:bg-[#1666d4]" onClick={() => go('perm', 'done')} data-testid="sim-perm-btn">{t('ss.perm.btn')}</Button>
              </>)}
              {step === 'done' && (<>
                <CheckCircle2 className="h-10 w-10 text-leaf" aria-hidden /><h3 className="text-xl font-bold">{t('ss.done.title')}</h3><p className="text-sm text-muted-foreground">{t('ss.done.sub')}</p>
                <Button className="mt-auto h-11 bg-[#1877F2] text-white hover:bg-[#1666d4]" onClick={finish} data-testid="sim-done-btn">{t('ss.done.btn')}</Button>
              </>)}
              {step === 'working' && (<>
                <h3 className="text-xl font-bold">{t('ss.work.title')}</h3>
                {error ? (<>
                  <p role="alert" className="text-sm font-medium text-destructive" data-testid="sim-error">{t('ss.work.error', { message: error })}</p>
                  <Button className="mt-auto h-11" variant="outline" onClick={() => setStep('phone')} data-testid="sim-work-back">{t('ss.work.back')}</Button>
                </>) : (<>
                  <p className="text-sm text-muted-foreground">{t('ss.work.sub')}</p>
                  {(!trace || shown < trace.length) ? <p className="flex items-center gap-2 text-sm font-semibold"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t('ss.work.title')}…</p> : <p className="flex items-center gap-2 text-sm font-semibold text-leaf" data-testid="sim-work-ok"><CheckCircle2 className="h-5 w-5" aria-hidden />{t('ss.work.ok')}</p>}
                  {trace && shown >= trace.length && <Button className="mt-auto h-11 bg-[#1877F2] text-white hover:bg-[#1666d4]" onClick={() => setStep('bill')} data-testid="sim-work-continue">{t('ss.work.continue')}</Button>}
                </>)}
              </>)}
              {step === 'bill' && (<>
                <h3 className="text-xl font-bold">{t('ss.bill.title')}</h3><p className="text-sm text-muted-foreground">{t('ss.bill.sub')}</p>
                {paid === null && (<div className="flex flex-col gap-2"><Button className="h-11 bg-[#1877F2] text-white hover:bg-[#1666d4]" onClick={() => setPaid('added')} data-testid="sim-bill-add">{t('ss.bill.add')}</Button><Button className="h-11" variant="outline" onClick={() => setPaid('later')} data-testid="sim-bill-later">{t('ss.bill.later')}</Button></div>)}
                {paid === 'added' && <p role="status" className="rounded-xl bg-mint/50 p-3 text-sm" data-testid="sim-bill-added">{t('ss.bill.added')}</p>}
                {paid === 'later' && <p role="status" className="rounded-xl bg-amber-soft p-3 text-sm text-amber-ink" data-testid="sim-bill-warn">{t('ss.bill.warn')}</p>}
                {paid !== null && <Button className="mt-auto h-11" onClick={() => close(false)} data-testid="sim-bill-close">{t('ss.bill.close')}</Button>}
              </>)}
            </div>
          </div>

          {/* the customer's checklist: what to give, why, and what is done */}
          <aside className="flex min-w-0 flex-col gap-4 rounded-2xl bg-mint/50 p-5" data-testid="sim-side" data-plan={plan}>
            <div>
              <h3 className="flex items-center gap-2 font-display text-2xl font-bold"><ShieldCheck className="h-6 w-6 text-leaf" aria-hidden />{t('ss.c.title')}</h3>
              <p className="mt-1 text-base text-body">{t('ss.c.sub')}</p>
            </div>
            {step === 'working' && !error && <p className="flex items-center gap-2 rounded-xl bg-white p-3 text-base font-semibold" role="status" data-testid="sim-connecting">{(!trace || shown < trace.length) ? <Loader2 className="h-5 w-5 animate-spin text-leaf" aria-hidden /> : <CheckCircle2 className="h-5 w-5 text-leaf" aria-hidden />}{t('ss.c.connecting')}</p>}
            <ol className="flex flex-col gap-2.5" data-testid="sim-items">
              {keys.map((k) => {
                const st = itemState(k);
                const ready = k === 'ready';
                return (
                  <li key={k} data-testid={`sim-item-${k}`} data-state={st}
                    className={`flex gap-3 rounded-xl p-3.5 ${ready && st === 'done' ? 'bg-leaf text-white' : st === 'current' ? 'border-2 border-leaf bg-white' : st === 'attention' ? 'border-2 border-amber bg-amber-soft text-amber-ink' : st === 'done' ? 'bg-white/70' : 'bg-white/40 text-muted-foreground'}`}>
                    {st === 'done' ? <CheckCircle2 className={`mt-0.5 h-6 w-6 shrink-0 ${ready ? 'text-white' : 'text-leaf'}`} aria-label={t('ss.c.done')} />
                      : st === 'attention' ? <AlertTriangle className="mt-0.5 h-6 w-6 shrink-0 text-amber" aria-hidden />
                      : <Circle className={`mt-0.5 h-6 w-6 shrink-0 ${st === 'current' ? 'text-leaf' : 'text-muted-foreground'}`} aria-hidden />}
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-[17px] font-bold leading-snug">
                        {t(`ss.c.${plan}.${k}` as TKey)}
                        {st === 'current' && <span className="rounded-full bg-leaf px-2 py-0.5 text-xs font-semibold text-white">{t('ss.c.now')}</span>}
                        {st === 'attention' && <span className="rounded-full bg-amber px-2 py-0.5 text-xs font-semibold text-white">{t('ss.c.required')}</span>}
                      </p>
                      {(st !== 'done' || ready) && <p className="mt-1 text-[15px] leading-snug">{t(`ss.c.${plan}.${k}.why` as TKey)}</p>}
                      {ready && st === 'done' && (
                        <div className="mt-2 flex flex-col gap-1.5 text-sm text-white/90" data-testid="sim-notices">
                          <p>{t('ss.c.notice.templates')}</p>
                          {plan === 'app' && <p>{t('ss.c.notice.sync')}</p>}
                          {paid === 'later' && <p>{t('ss.c.notice.pay')}</p>}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            {trace && event && (
              <details className="rounded-xl border border-dashed border-line bg-white/60 p-3 text-xs" data-testid="sim-tester">
                <summary className="cursor-pointer font-semibold">{t('ss.t.title')}</summary>
                <div className="mt-2 rounded-lg bg-ink p-2 text-white" data-testid="sim-event"><p className="mb-1 font-bold">{t('ss.event.title')}</p><pre className="overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(event, null, 2)}</pre><p className="mt-1 text-white/70">{t('ss.event.note')}</p></div>
                <ol className="mt-2 flex flex-col gap-1.5" data-testid="sim-trace">{trace.map((s, i) => (<li key={`${s.key}-${i}`} className="flex gap-2" data-testid={`sim-trace-${s.key}`}><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-leaf" aria-hidden /><span>{stepLabel(s)}</span></li>))}</ol>
                <p className="mt-2 text-muted-foreground">{t('ss.work.note')}</p>
              </details>
            )}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
