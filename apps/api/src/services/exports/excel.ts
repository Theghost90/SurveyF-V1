import ExcelJS from 'exceljs';
import { formatPhone } from '@surveyflow/shared';
import { prisma } from '../../lib/prisma';
import { computeAnalytics, displayAnswer, getParticipantRows } from '../analytics';

/**
 * Spec: Sheet 1 = Summary (metrics) · Sheet 2 = Raw responses (one row per participant) ·
 * Sheet 3 = Contacts who didn't start.
 *
 * Free-text answers are untrusted input that the owner opens in Excel. ExcelJS writes JS strings as
 * text cells (never formulas), so "=HYPERLINK(...)" stays inert; we still cap cell length.
 */
const clip = (s: string) => (s.length > 32_000 ? s.slice(0, 32_000) : s);
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2B22' } };

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = HEADER_FILL;
  row.alignment = { vertical: 'middle' };
  row.height = 22;
}

export async function buildExcel(surveyId: string, userId: string): Promise<Buffer> {
  const a = await computeAnalytics(surveyId, userId);
  const { survey, rows } = await getParticipantRows(surveyId, userId, { onlyEngaged: true });
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SurveyFlow';
  wb.created = new Date();

  // ---- Sheet 1: Summary ---------------------------------------------------------------------
  const s1 = wb.addWorksheet('Summary');
  s1.columns = [{ width: 34 }, { width: 18 }, { width: 14 }, { width: 14 }];
  s1.addRow([a.survey.title]).font = { bold: true, size: 16 };
  s1.addRow([`Exported ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`]).font = { color: { argb: 'FF666666' } };
  s1.addRow([]);
  styleHeader(s1.addRow(['Metric', 'Value']));
  const t = a.totals;
  const metrics: Array<[string, string | number]> = [
    ['Invitations sent', t.sent], ['Started', t.started], ['Completed', t.completed], ['Completion rate (completed ÷ started)', `${t.completionRate}%`],
    ['Response rate (started ÷ sent)', `${t.responseRate}%`], ['Abandoned', t.abandoned], ['Declined ("Not now")', t.declined], ['No reply', t.noReply],
    ['In progress', t.inProgress], ['Failed to send', t.failed], ['Average completion time (s)', t.avgCompletionSeconds ?? '—'],
  ];
  metrics.forEach((m) => s1.addRow(m));
  s1.addRow([]);
  for (const q of a.perQuestion) {
    s1.addRow([`Q${q.number}. ${clip(q.text)}`]).font = { bold: true };
    s1.addRow([`Answered ${q.answered} · skipped ${q.skipped} · abandoned here ${q.abandonedHere}${q.average !== null ? ` · average ${q.average}` : ''}`]).font = { color: { argb: 'FF666666' } };
    if (q.type === 'text') {
      q.texts.slice(0, 10).forEach((x) => s1.addRow([clip(x.answer), x.name]));
    } else {
      styleHeader(s1.addRow(['Option', 'Count', '%']));
      q.distribution.forEach((d) => s1.addRow([d.label, d.count, `${d.pct}%`]));
    }
    s1.addRow([]);
  }

  // ---- Sheet 2: Raw responses ---------------------------------------------------------------------
  const s2 = wb.addWorksheet('Raw responses');
  const header = ['Name', 'Phone', 'Status', 'Started at', 'Completed at', 'Abandoned at question', ...survey.questions.map((q, i) => `Q${i + 1}. ${q.text}`)];
  styleHeader(s2.addRow(header));
  for (const r of rows) {
    s2.addRow([
      r.name, formatPhone(r.phone), r.status, r.startedAt ?? '', r.completedAt ?? '', r.abandonedAtQuestion ?? '',
      ...survey.questions.map((q) => clip(displayAnswer(q.type, r.answers[q.id]))),
    ]);
  }
  s2.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }];
  s2.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };
  s2.columns.forEach((c, i) => { c.width = i < 2 ? 22 : i < 6 ? 20 : 34; });
  [4, 5].forEach((c) => (s2.getColumn(c).numFmt = 'yyyy-mm-dd hh:mm'));

  // ---- Sheet 3: contacts who didn't start -----------------------------------------------------------------
  const s3 = wb.addWorksheet("Didn't start");
  styleHeader(s3.addRow(['Name', 'Phone', 'Status', 'Invitation sent at']));
  const nonStarters = await prisma.surveyRecipient.findMany({
    where: { surveyId, status: { in: ['sent', 'delivered', 'declined', 'failed'] } },
    include: { contact: true }, orderBy: { sentAt: 'desc' },
  });
  nonStarters.forEach((r) => s3.addRow([r.contact.name, formatPhone(r.contact.phone), r.status === 'declined' ? 'declined ("Not now")' : r.status, r.sentAt ?? '']));
  s3.columns.forEach((c, i) => { c.width = [24, 22, 22, 22][i]; });
  s3.getColumn(4).numFmt = 'yyyy-mm-dd hh:mm';

  return Buffer.from(await wb.xlsx.writeBuffer());
}
