'use client';
import { useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useT } from '@/lib/i18n/client';

const SAMPLE_CSV = 'name,phone,tags\nMarie N.,+237 677 12 34 56,vip\nPaul K.,677 65 43 21,\n';

function ConsentBox({ checked, onChange, id }: { checked: boolean; onChange: (v: boolean) => void; id: string }) {
  const t = useT();
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3 rounded-xl bg-canvas p-4 text-sm">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(!!v)} className="mt-0.5" />
      <span><b>{t('c.consent')}</b><br /><span className="text-muted-foreground">{t('c.consentHint')}</span></span>
    </label>
  );
}

export function AddContactDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const t = useT();
  const [form, setForm] = useState({ name: '', phone: '+237 ', tags: '' });
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/contacts', { body: { name: form.name, phone: form.phone, tags: form.tags.split(',').map((x) => x.trim()).filter(Boolean), consent } });
      toast.success(t('c.added'));
      setForm({ name: '', phone: '+237 ', tags: '' });
      setConsent(false);
      onOpenChange(false);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError && err.issues?.length ? err.issues[0]!.message : errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('common.close')}>
        <DialogHeader><DialogTitle>{t('c.add')}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <Field label={t('common.name')} htmlFor="c-name"><Input id="c-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="off" /></Field>
          <Field label={t('common.phone')} htmlFor="c-phone" hint={t('register.phoneHint')}><Input id="c-phone" type="tel" required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} autoComplete="off" /></Field>
          <Field label={t('c.tags')} htmlFor="c-tags" hint={t('c.tagsHint')}><Input id="c-tags" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} autoComplete="off" /></Field>
          <ConsentBox id="c-consent" checked={consent} onChange={setConsent} />
          {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
          <DialogFooter><Button variant="outline" type="button" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button><Button type="submit" loading={busy} disabled={!consent || !form.name.trim()}>{t('common.add')}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ImportDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const [tags, setTags] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; updated: number; skipped: number; errors: Array<{ row: number; reason: string }> } | null>(null);

  const reset = () => { setFile(null); setTags(''); setConsent(false); setResult(null); setError(null); };
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('consent', 'true');
      if (tags.trim()) form.append('tags', tags);
      form.append('file', file);
      setResult(await api('/contacts/import', { form }));
      onDone();
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent closeLabel={t('common.close')}>
        <DialogHeader><DialogTitle>{t('c.import')}</DialogTitle><DialogDescription>{t('c.importHelp')}</DialogDescription></DialogHeader>
        {result ? (
          <div className="grid gap-3" role="status">
            <p className="rounded-xl bg-mint/60 p-4 font-semibold text-leaf">{t('c.importResult', { created: result.created, updated: result.updated, skipped: result.skipped })}</p>
            {result.errors.length > 0 && (
              <ul className="max-h-40 overflow-y-auto rounded-xl border border-line p-3 text-sm scrollbar-thin">
                {result.errors.map((e) => <li key={e.row}>{t('c.row', { n: e.row })}: {e.reason}</li>)}
              </ul>
            )}
            <DialogFooter><Button onClick={() => { onOpenChange(false); reset(); }}>{t('common.close')}</Button></DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <Field label="CSV" htmlFor="c-file" hint={t('c.csvHint')}>
              <Input id="c-file" type="file" accept=".csv,text/csv" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="h-auto py-2.5" />
            </Field>
            <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE_CSV)}`} download="surveyflow-contacts-sample.csv" className="flex items-center gap-1.5 text-sm font-semibold text-leaf hover:underline"><Download className="h-4 w-4" aria-hidden />{t('c.sample')}</a>
            <Field label={t('c.defaultTags')} htmlFor="c-dtags" hint={t('c.tagsHint')}><Input id="c-dtags" value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
            <ConsentBox id="c-import-consent" checked={consent} onChange={setConsent} />
            {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
            <DialogFooter><Button variant="outline" type="button" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button><Button type="submit" loading={busy} disabled={!file || !consent}><Upload className="h-4 w-4" aria-hidden />{t('c.importCta')}</Button></DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
