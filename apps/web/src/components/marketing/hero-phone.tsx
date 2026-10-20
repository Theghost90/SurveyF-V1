import { Gift } from 'lucide-react';
import { getT } from '@/lib/i18n/server';
import { Rich } from './rich';

/** The design's phone: an example survey chat with two floating cards. Content is clearly labelled as an example. */
export function HeroPhone() {
  const { t } = getT();
  const bubbleIn = 'self-start max-w-[86%] rounded-[4px_12px_12px_12px] bg-white px-3 py-2.5';
  const bubbleOut = 'self-end rounded-[12px_4px_12px_12px] bg-wa-out px-3 py-2';
  return (
    <div className="relative flex min-w-0 flex-1 basis-[480px] justify-center pb-[30px] pt-5" aria-hidden="false">
      <div className="absolute left-1/2 top-10 -ml-[220px] h-[440px] w-[440px] rounded-full bg-mint" aria-hidden />
      <div className="relative w-[324px] rounded-[40px] bg-ink p-3 shadow-phone">
        <div className="flex flex-col overflow-hidden rounded-[30px] bg-wa-bg">
          <div className="flex items-center gap-2.5 bg-wa-header px-4 pb-3 pt-4 text-white">
            <div className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-amber text-sm font-bold text-ink">BA</div>
            <div className="flex flex-col"><span className="text-sm font-semibold">{t('hero.chatName')}</span><span className="text-[11px] opacity-80">{t('hero.chatExample')}</span></div>
          </div>
          <div className="flex flex-col gap-2 px-3 pb-[18px] pt-3.5 text-[13px] leading-[1.4]">
            <div className={bubbleIn}><Rich text={t('hero.chat1')} /></div>
            <div className={bubbleIn}>
              {t('hero.chat2')}
              <br />
              <span className="font-semibold text-leaf">1</span> {t('hero.chat2a')} · <span className="font-semibold text-leaf">2</span> {t('hero.chat2b')} · <span className="font-semibold text-leaf">3</span> {t('hero.chat2c')}
            </div>
            <div className={bubbleOut}>3</div>
            <div className={bubbleIn}>{t('hero.chat3')}</div>
            <div className={`${bubbleOut} max-w-[86%]`}>{t('hero.chat4')}</div>
            <div className="flex items-center gap-1.5 self-center rounded-[10px] bg-amber-soft px-3 py-2 text-xs font-semibold text-amber-ink">
              <Gift className="h-3.5 w-3.5" aria-hidden />
              {t('hero.chatGift')}
            </div>
          </div>
        </div>
      </div>
      <div className="absolute right-0 top-[70px] hidden w-[252px] flex-col gap-2.5 rounded-[18px] bg-white p-4 shadow-float min-[560px]:flex">
        <span className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">{t('hero.insight')}</span>
        <span className="font-display text-lg font-bold leading-[1.2]">{t('hero.insightTitle')}</span>
        <div className="flex flex-col gap-1.5 text-xs" aria-hidden>
          {[
            [t('hero.chat2a'), 90, 'bg-brand'],
            [t('hero.chat2b'), 54, 'bg-mint-2'],
            [t('hero.chat2c'), 70, 'bg-amber'],
          ].map(([label, w, color]) => (
            <div key={label as string} className="flex items-center gap-2"><span className="w-14">{label}</span><span className={`h-2 rounded ${color}`} style={{ width: w as number }} /></div>
          ))}
        </div>
      </div>
      <div className="absolute bottom-[60px] left-0 hidden flex-col gap-0.5 rounded-2xl bg-ink px-4 py-3.5 text-white shadow-float min-[560px]:flex">
        <span className="text-xs opacity-75">{t('hero.onDash')}</span>
        <span className="text-[15px] font-semibold">{t('hero.newAnswers')}</span>
      </div>
    </div>
  );
}
