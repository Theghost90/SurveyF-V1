'use client';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlignLeft, CircleDot, GripVertical, List, Plus, Star, Trash2, X, ListChecks } from 'lucide-react';
import { WA_LIMITS, type QuestionType } from '@surveyflow/shared';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';
import { labelLimit, newOption, optionLimit, type QuestionDraft, type QuestionErrors } from './types';

export const TYPE_META: Record<QuestionType, { icon: typeof List; key: 'b.type.button' | 'b.type.list' | 'b.type.text' | 'b.type.rating' | 'b.type.multi' }> = {
  button: { icon: CircleDot, key: 'b.type.button' },
  list: { icon: List, key: 'b.type.list' },
  text: { icon: AlignLeft, key: 'b.type.text' },
  rating: { icon: Star, key: 'b.type.rating' },
  multi: { icon: ListChecks, key: 'b.type.multi' },
};

export function QuestionCard({ q, index, errors, locked, active, onChange, onRemove, onFocus }: {
  q: QuestionDraft; index: number; errors?: QuestionErrors; locked: boolean; active: boolean;
  onChange: (q: QuestionDraft) => void; onRemove: () => void; onFocus: () => void;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: q.key, disabled: locked });
  const max = optionLimit(q.type);
  const hasOptions = q.type === 'button' || q.type === 'list' || q.type === 'multi';

  const setType = (type: QuestionType) => {
    const keep = type === 'button' || type === 'list' || type === 'multi' ? (q.options.length ? q.options : [newOption(), newOption()]) : [];
    onChange({ ...q, type, options: keep.slice(0, optionLimit(type) || 0) });
  };

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onFocusCapture={onFocus}
      onClick={onFocus}
      className={cn('rounded-2xl border bg-white p-4 sm:p-5', active ? 'border-leaf ring-2 ring-leaf/15' : 'border-line', isDragging && 'z-10 shadow-float', errors && 'border-destructive/60')}
    >
      <div className="flex items-start gap-3">
        <button type="button" {...attributes} {...listeners} disabled={locked} aria-label={`${t('b.q.drag')} ${index + 1}`} className="mt-1 flex h-9 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-muted-foreground hover:bg-mint/60 disabled:cursor-not-allowed disabled:opacity-40 active:cursor-grabbing">
          <GripVertical className="h-5 w-5" aria-hidden />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-start gap-2">
            <span className="mt-2.5 font-display text-lg font-extrabold text-leaf">Q{index + 1}</span>
            <div className="flex-1">
              <label htmlFor={`q-${q.key}`} className="sr-only">{t('b.q.text')} {index + 1}</label>
              <Textarea id={`q-${q.key}`} rows={2} value={q.text} disabled={locked} maxLength={WA_LIMITS.questionText + 50} onChange={(e) => onChange({ ...q, text: e.target.value })} placeholder={t('b.q.placeholder')} aria-invalid={!!errors?.text} className="min-h-[64px] resize-y" />
              {errors?.text && <p role="alert" className="mt-1 text-xs font-medium text-destructive">{errors.text}</p>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <div className="w-full sm:w-64">
              <Select value={q.type} onValueChange={(v) => setType(v as QuestionType)} disabled={locked}>
                <SelectTrigger aria-label={t('b.q.type')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(TYPE_META) as QuestionType[]).map((k) => {
                    const Icon = TYPE_META[k].icon;
                    return <SelectItem key={k} value={k}><span className="flex items-center gap-2"><Icon className="h-4 w-4 text-leaf" aria-hidden />{t(TYPE_META[k].key)}</span></SelectItem>;
                  })}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2.5 text-sm font-medium">
              <Switch checked={q.required} disabled={locked} onCheckedChange={(v) => onChange({ ...q, required: v })} aria-label={t('b.q.required')} />
              {t('b.q.required')}
            </label>
            <Button variant="ghost" size="sm" disabled={locked} onClick={onRemove} className="ml-auto text-destructive hover:bg-red-50" aria-label={`${t('common.delete')} Q${index + 1}`}><Trash2 className="h-4 w-4" aria-hidden />{t('common.delete')}</Button>
          </div>

          {q.type === 'rating' && <p className="rounded-xl bg-canvas px-3 py-2 text-sm text-muted-foreground">{t('b.q.ratingNote')}</p>}
          {q.type === 'text' && <p className="rounded-xl bg-canvas px-3 py-2 text-sm text-muted-foreground">{t('b.q.textNote')}</p>}

          {hasOptions && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold text-muted-foreground">
                {q.type === 'button' ? t('b.q.limitButton', { n: max, c: labelLimit('button') }) : q.type === 'list' ? t('b.q.limitList', { n: max, c: labelLimit('list') }) : t('b.q.limitMulti', { n: max })}
              </p>
              {q.options.map((o, i) => (
                <div key={o.id} className="flex items-start gap-2">
                  <div className="flex-1">
                    <label htmlFor={`o-${o.id}`} className="sr-only">{t('b.q.option')} {i + 1}</label>
                    <div className="relative">
                      <Input id={`o-${o.id}`} value={o.label} disabled={locked} onChange={(e) => onChange({ ...q, options: q.options.map((x) => (x.id === o.id ? { ...x, label: e.target.value } : x)) })} placeholder={`${t('b.q.option')} ${i + 1}`} aria-invalid={!!errors?.labels[i]} className="h-10 pr-14" />
                      <span className={cn('pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] tabular-nums', o.label.length > labelLimit(q.type) ? 'font-bold text-destructive' : 'text-muted-foreground')}>{o.label.length}/{labelLimit(q.type)}</span>
                    </div>
                    {errors?.labels[i] && <p role="alert" className="mt-1 text-xs font-medium text-destructive">{errors.labels[i]}</p>}
                  </div>
                  <Button variant="ghost" size="icon" className="h-10 w-10" disabled={locked || q.options.length <= 2} onClick={() => onChange({ ...q, options: q.options.filter((x) => x.id !== o.id) })} aria-label={`${t('common.remove')} ${t('b.q.option')} ${i + 1}`}><X className="h-4 w-4" aria-hidden /></Button>
                </div>
              ))}
              {errors?.options && <p role="alert" className="text-xs font-medium text-destructive">{errors.options}</p>}
              <Button variant="outline" size="sm" className="self-start" disabled={locked || q.options.length >= max} onClick={() => onChange({ ...q, options: [...q.options, newOption()] })}>
                <Plus className="h-4 w-4" aria-hidden />{t('b.q.addOption')}
              </Button>
              {q.type === 'button' && q.options.length >= max && <p className="text-xs text-muted-foreground">{t('b.q.useList')}</p>}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
