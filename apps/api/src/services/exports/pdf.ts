import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer';
import { formatPhone } from '@surveyflow/shared';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { computeAnalytics, displayAnswer, getParticipantRows, type AnalyticsResult } from '../analytics';

/**
 * PDF report: Puppeteer renders an HTML template with Chart.js charts.
 * Cover · executive summary · funnel · per-question charts · response list (spec "EXPORT LOGIC").
 *
 * Security: participants' answers are untrusted text going into HTML that a headless browser renders.
 * Everything is HTML-escaped, JSON for charts is embedded with `<` escaped, and ALL network requests
 * from the page are aborted (no SSRF / exfiltration through injected markup). Chart.js is inlined
 * from node_modules so rendering works offline.
 */

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, '');

let chartJs: string | null = null;
function chartSource(): string {
  if (!chartJs) {
    const req = createRequire(import.meta.url);
    // chart.js's "exports" map hides dist/chart.umd.js, so locate it next to the resolved entry (dist/chart.cjs).
    chartJs = readFileSync(join(dirname(req.resolve('chart.js')), 'chart.umd.min.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  }
  return chartJs;
}

// ---- browser pool -------------------------------------------------------------------------------

let browserPromise: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: true,
        executablePath: env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      })
      .then((b) => {
        b.on('disconnected', () => { browserPromise = null; });
        return b;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

let active = 0;
const waiters: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  const MAX = 2; // each render is a Chromium page: cap concurrency to protect the API process
  if (active >= MAX) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

export async function closeBrowser() {
  if (browserPromise) await (await browserPromise).close().catch(() => undefined);
  browserPromise = null;
}

// ---- template ------------------------------------------------------------------------------------

const CSS = `
*{box-sizing:border-box}body{margin:0;font:13px/1.5 'Helvetica Neue',Arial,sans-serif;color:#0B2B22}
.page{page-break-after:always;padding:0}.page:last-child{page-break-after:auto}
.cover{height:257mm;background:#0B2B22;color:#fff;padding:22mm 18mm;display:flex;flex-direction:column;justify-content:space-between;border-radius:6px}
.brand{font-weight:800;font-size:20px;letter-spacing:-.02em}.brand i{display:inline-block;width:10px;height:10px;border-radius:50%;background:#2BD46E;margin-right:8px}
.cover h1{font-size:40px;line-height:1.05;letter-spacing:-.03em;margin:0 0 10px}.cover .sub{color:#B5C9BD;font-size:15px}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.kpi{border:1px solid #DCE4DE;border-radius:10px;padding:12px 14px;background:#fff}
.cover .kpi{background:#12392E;border-color:#1B4A3B}.kpi b{display:block;font-size:26px;letter-spacing:-.02em}.kpi span{font-size:11px;color:#4A5D55;text-transform:uppercase;letter-spacing:.06em}
.cover .kpi span{color:#B5C9BD}
h2{font-size:20px;margin:0 0 4px;letter-spacing:-.02em}h3{font-size:14px;margin:0 0 2px}.muted{color:#4A5D55}
.callout{background:#FFF4E0;border-radius:10px;padding:12px 14px;margin:14px 0;color:#5A4A2E}
.q{break-inside:avoid;border:1px solid #DCE4DE;border-radius:12px;padding:14px;margin:0 0 14px}
.q canvas{margin-top:8px}.bubble{background:#F4F6F1;border-radius:8px;padding:6px 10px;margin:4px 0;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:11px}th{background:#0B2B22;color:#fff;text-align:left;padding:6px 8px}td{padding:5px 8px;border-bottom:1px solid #E3E9E5;vertical-align:top}
.tag{font-size:10px;padding:2px 7px;border-radius:99px;background:#DDEFE3}
`;

function qBlock(q: AnalyticsResult['perQuestion'][number], idx: number): string {
  const head = `<h3>Q${q.number}. ${esc(q.text)}</h3><div class="muted">${q.answered} answered${q.skipped ? ` · ${q.skipped} skipped` : ''}${q.abandonedHere ? ` · ${q.abandonedHere} left here` : ''}${q.average !== null ? ` · average ${q.average} / 5` : ''}</div>`;
  if (q.type === 'text') {
    const items = q.texts.slice(0, 10).map((t) => `<div class="bubble">“${esc(t.answer)}” <span class="muted">— ${esc(t.name)}</span></div>`).join('');
    return `<div class="q">${head}${items || '<div class="muted">No answers yet.</div>'}</div>`;
  }
  return `<div class="q">${head}<canvas id="qc${idx}" height="${Math.max(70, q.distribution.length * 26)}"></canvas></div>`;
}

export function buildReportHtml(a: AnalyticsResult, rows: Array<{ name: string; phone: string; status: string; completedAt: Date | null; cells: string[] }>, questionHeads: string[], businessName: string): string {
  const t = a.totals;
  const date = new Date().toISOString().slice(0, 10);
  const charts: Array<{ id: string; type: 'bar'; labels: string[]; data: number[]; color: string; horizontal: boolean }> = [
    { id: 'funnel', type: 'bar', labels: a.funnel.map((f) => f.label), data: a.funnel.map((f) => f.count), color: '#0F7A40', horizontal: true },
    ...a.perQuestion.flatMap((q, i) => (q.type === 'text' ? [] : [{ id: `qc${i}`, type: 'bar' as const, labels: q.distribution.map((d) => d.label), data: q.distribution.map((d) => d.count), color: q.type === 'rating' ? '#E9A23B' : '#2BD46E', horizontal: q.type !== 'rating' }])),
  ];
  const dropOff = a.dropOff
    ? `<div class="callout"><b>Biggest drop-off:</b> ${a.dropOff.count} participant${a.dropOff.count === 1 ? '' : 's'} left at Q${a.dropOff.questionNumber} (“${esc(a.dropOff.questionText)}”).</div>`
    : '';
  const topRows = rows.slice(0, 200);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<section class="page cover"><div class="brand"><i></i>SurveyFlow</div>
  <div><h1>${esc(a.survey.title)}</h1><div class="sub">${esc(businessName)} · Survey report · ${date}</div></div>
  <div class="kpis">
    <div class="kpi"><b>${t.sent}</b><span>Invitations sent</span></div><div class="kpi"><b>${t.completed}</b><span>Completed</span></div><div class="kpi"><b>${t.completionRate}%</b><span>Completion rate</span></div>
  </div></section>
<section class="page"><h2>Executive summary</h2><p class="muted">Completion rate is completed ÷ started. Response rate is started ÷ sent.</p>
  <div class="kpis" style="margin-top:10px">
    <div class="kpi"><b>${t.started}</b><span>Started</span></div><div class="kpi"><b>${t.responseRate}%</b><span>Response rate</span></div><div class="kpi"><b>${t.noReply}</b><span>No reply</span></div>
    <div class="kpi"><b>${t.abandoned}</b><span>Abandoned</span></div><div class="kpi"><b>${t.declined}</b><span>Declined</span></div><div class="kpi"><b>${t.avgCompletionSeconds ?? '—'}${t.avgCompletionSeconds ? ' s' : ''}</b><span>Avg completion time</span></div>
  </div>${dropOff}
  <h2 style="margin-top:18px">Funnel</h2><canvas id="funnel" height="110"></canvas></section>
<section class="page"><h2>Results by question</h2><p class="muted">Percentages are relative to the answers to each question.</p>
  ${a.perQuestion.map((q, i) => qBlock(q, i)).join('')}</section>
<section class="page"><h2>Responses</h2><p class="muted">${rows.length > 200 ? 'First 200 of ' + rows.length + ' participants — download the Excel export for all.' : rows.length + ' participants.'}</p>
  <table><thead><tr><th>Participant</th><th>Status</th>${questionHeads.map((h, i) => `<th>Q${i + 1}</th>`).join('')}</tr></thead><tbody>
  ${topRows.map((r) => `<tr><td>${esc(r.name)}<br><span class="muted">${esc(r.phone)}</span></td><td><span class="tag">${esc(r.status)}</span></td>${r.cells.map((c) => `<td>${esc(c.slice(0, 160))}</td>`).join('')}</tr>`).join('')}
  </tbody></table></section>
<script>${chartSource()}</script>
<script>
const specs=${safeJson(charts)};
Chart.defaults.animation=false;Chart.defaults.font.family="Helvetica Neue, Arial, sans-serif";
for(const s of specs){const el=document.getElementById(s.id);if(!el)continue;
 new Chart(el,{type:'bar',data:{labels:s.labels,datasets:[{data:s.data,backgroundColor:s.color,borderRadius:4}]},
  options:{indexAxis:s.horizontal?'y':'x',plugins:{legend:{display:false}},scales:{x:{beginAtZero:true,ticks:{precision:0}},y:{beginAtZero:true,ticks:{precision:0}}}}});}
window.__done=true;
</script></body></html>`;
}

/** Small documents (receipts): same locked-down page as the report — every network request is aborted, no scripts needed. */
export async function htmlToPdf(html: string): Promise<Buffer> {
  return withSlot(async () => {
    const page = await (await getBrowser()).newPage();
    try {
      await page.setRequestInterception(true);
      page.on('request', (r) => (r.url().startsWith('data:') || r.url() === 'about:blank' ? r.continue() : r.abort()));
      await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
      return Buffer.from(await page.pdf({ format: 'A5', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } }));
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}

export async function buildPdf(surveyId: string, userId: string): Promise<Buffer> {
  const a = await computeAnalytics(surveyId, userId);
  const { survey, rows } = await getParticipantRows(surveyId, userId, { take: 1000 });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { businessName: true } });
  const html = buildReportHtml(
    a,
    rows.map((r) => ({ name: r.name, phone: formatPhone(r.phone), status: r.status, completedAt: r.completedAt, cells: survey.questions.map((q) => displayAnswer(q.type, r.answers[q.id])) })),
    survey.questions.map((q) => q.text),
    user.businessName,
  );

  return withSlot(async () => {
    const page = await (await getBrowser()).newPage();
    try {
      await page.setRequestInterception(true);
      page.on('request', (r) => (r.url().startsWith('data:') || r.url() === 'about:blank' ? r.continue() : r.abort()));
      await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForFunction('window.__done === true', { timeout: 15_000 });
      const pdf = await page.pdf({
        format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
        displayHeaderFooter: true, headerTemplate: '<span></span>',
        footerTemplate: '<div style="width:100%;font-size:8px;color:#888;padding:0 12mm;display:flex;justify-content:space-between"><span>SurveyFlow</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
      });
      return Buffer.from(pdf);
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}
