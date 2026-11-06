import Link from 'next/link';
import type { Block, LegalDoc } from '@/lib/legal';

const MARKS = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g;

/** Only three links are ever drawn: inside the site, to an anchor, or an e-mail address. Anything else is shown as its label. */
function safeHref(href: string): boolean {
  return href.startsWith('/') || href.startsWith('#') || href.startsWith('mailto:');
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(MARKS).map((part, i) => {
        const bold = /^\*\*([^*]+)\*\*$/.exec(part);
        if (bold) return <b key={i} className="font-semibold text-ink">{bold[1]}</b>;
        const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
        if (link) {
          const [, label, href] = link;
          if (!safeHref(href)) return <span key={i}>{label}</span>;
          const cls = 'font-semibold text-leaf underline-offset-2 hover:underline';
          return href.startsWith('/') ? <Link key={i} href={href} className={cls}>{label}</Link> : <a key={i} href={href} className={cls}>{label}</a>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  if ('p' in block) return <p><Inline text={block.p} /></p>;
  if ('ul' in block) return <ul className="list-disc space-y-2 pl-5">{block.ul.map((t, i) => <li key={i}><Inline text={t} /></li>)}</ul>;
  if ('ol' in block) return <ol className="list-decimal space-y-3 pl-5">{block.ol.map((t, i) => <li key={i}><Inline text={t} /></li>)}</ol>;
  return (
    <dl className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
      {block.rows.map(([k, v], i) => (
        <div key={i} className="grid gap-1 px-4 py-3 sm:grid-cols-[13rem_1fr] sm:gap-6">
          <dt className="font-semibold text-ink"><Inline text={k} /></dt>
          <dd><Inline text={v} /></dd>
        </div>
      ))}
    </dl>
  );
}

/** A legal document: title, version line, lead, table of contents, and the numbered sections (the number is the position, which some sentences point to). */
export function LegalDocView({ doc }: { doc: LegalDoc }) {
  return (
    <article className="mx-auto max-w-3xl px-5 pb-20 pt-6 sm:px-8">
      <h1 className="text-4xl font-extrabold tracking-[-0.03em] sm:text-5xl">{doc.title}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{doc.meta}</p>
      <p className="mt-6 leading-relaxed text-body">{doc.lead}</p>
      <nav aria-label={doc.tocLabel} className="mt-8 rounded-2xl bg-muted/50 p-5 text-sm">
        <p className="mb-2 font-bold text-ink">{doc.tocLabel}</p>
        <ol className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
          {doc.sections.map((s, i) => (
            <li key={s.id}><a href={`#${s.id}`} className="text-body hover:text-leaf">{i + 1}. {s.h}</a></li>
          ))}
        </ol>
      </nav>
      <div className="mt-10 space-y-10 leading-relaxed text-body">
        {doc.sections.map((s, i) => (
          <section key={s.id} id={s.id} className="scroll-mt-24 space-y-4">
            <h2 className="text-2xl font-extrabold tracking-[-0.02em] text-ink">{i + 1}. {s.h}</h2>
            {s.blocks.map((b, j) => <BlockView key={j} block={b} />)}
          </section>
        ))}
      </div>
    </article>
  );
}
