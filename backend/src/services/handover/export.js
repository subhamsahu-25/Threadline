import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

// Noto Sans (Latin) and Noto Sans Devanagari ship with the backend under the
// SIL Open Font License, so a PDF renders the same on every machine and never
// depends on fonts installed on the host.
const FONT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../assets/fonts',
);

const FONTS = {
  body: 'NotoSans-Regular.ttf',
  bold: 'NotoSans-SemiBold.ttf',
  deva: 'NotoSansDevanagari-Regular.ttf',
};

const COLORS = {
  ink: '#12202f',
  inkSoft: '#33465c',
  inkMuted: '#5b6a7e',
  line: '#e4e8ef',
  brand: '#164469',
  brandSoft: '#eef4fa',
  evidence: '#f5f8fc',
  warnBg: '#fdf6e3',
  warnLine: '#ead9a8',
  warnText: '#6b4b12',
  critical: '#b91c1c',
  warn: '#a16207',
};

const DEVANAGARI = /[\u0900-\u097F\uA8E0-\uA8FF]/;

function formatDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const day = formatDate(date);
  const time = date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
  return `${day}, ${time} UTC`;
}

function humanise(value) {
  const text = String(value || '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function ensureSpace(doc, height) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + height > bottom) doc.addPage();
}

function measure(doc, text, { font = 'body', size = 9.5, width, lineGap = 0 } = {}) {
  doc.font(font).fontSize(size);
  return doc.heightOfString(String(text ?? ''), {
    width: width ?? contentWidth(doc),
    lineGap,
  });
}

function scriptRuns(text) {
  const runs = [];
  for (const char of String(text)) {
    const script = DEVANAGARI.test(char) ? 'deva' : 'latin';
    const last = runs[runs.length - 1];
    if (last && last.script === script) last.text += char;
    else runs.push({ script, text: char });
  }
  return runs;
}

/**
 * Writes text with the right font per script. Devanagari has no glyphs in the
 * Latin face, so the string is split into runs and each run keeps the same
 * layout options; Latin runs honour the requested weight.
 */
function writeText(doc, text, opts = {}) {
  const value = String(text ?? '');
  if (!value) return;
  const { font = 'body', size = 9.5, color = COLORS.ink, ...layout } = opts;
  const latin = font === 'bold' ? 'bold' : 'body';

  if (!DEVANAGARI.test(value)) {
    doc.font(font).fontSize(size).fillColor(color).text(value, layout);
    return;
  }

  const runs = scriptRuns(value);
  runs.forEach((run, index) => {
    doc
      .font(run.script === 'deva' ? 'deva' : latin)
      .fontSize(size)
      .fillColor(color)
      .text(run.text, { ...layout, continued: index < runs.length - 1 });
  });
}

function writeTextAt(doc, text, x, y, opts = {}) {
  const keepX = doc.x;
  const keepY = doc.y;
  doc.x = x;
  doc.y = y;
  writeText(doc, text, opts);
  doc.x = keepX;
  doc.y = keepY;
}

/**
 * Builds the same permission-filtered view the reader sees on screen. It never
 * reads the database, so an export cannot include an item the viewer was not
 * allowed to open.
 */
export function buildHandoverExport({ handover, projectName, viewer }) {
  const snapshot = handover.snapshot || {};
  const recipientName = handover.recipientSnapshot?.name || 'the recipient';
  const projectLabel =
    snapshot.projectName || projectName || snapshot.projectKey || 'Project';

  const meta = [
    ['Project', projectLabel],
    ['Recipient', recipientName],
    [
      'Status',
      `${humanise(handover.status || 'draft')} · version ${handover.version ?? 1}`,
    ],
    ['Prepared by', handover.createdBySnapshot?.name || 'Project team'],
  ];
  if (handover.approvedAt) {
    meta.push([
      'Approved',
      `${formatDate(handover.approvedAt)} by ${
        handover.approvedBySnapshot?.name || 'a project lead'
      }`,
    ]);
  }
  if (handover.acknowledgedAt) {
    meta.push(['Acknowledged', formatDate(handover.acknowledgedAt)]);
  }
  meta.push(['Exported', formatDateTime(new Date())]);

  const items = (handover.items || []).map((item, index) => {
    const facts = [
      `Type: ${item.type}`,
      `Status: ${item.status || item.state || 'unknown'}`,
    ];
    if (item.ownerName) facts.push(`Owner: ${item.ownerName}`);
    if (item.dueAt) facts.push(`Due: ${formatDate(item.dueAt)}`);
    if (item.origin === 'person_confirmed') {
      facts.push(
        `Person-confirmed by ${item.confirmedByName || 'a teammate'}${
          item.confirmedAt ? ` on ${formatDate(item.confirmedAt)}` : ''
        }`,
      );
    }
    if (item.decision === 'edited') {
      facts.push('Wording reviewed by the project team');
    }
    return {
      index: index + 1,
      statement: String(item.statement || ''),
      facts,
      evidence: (item.citations || []).map((citation) => ({
        heading: `Evidence · ${citation.sourceName || 'Source'}${
          citation.docTitle ? ` · ${citation.docTitle}` : ''
        } (${citation.validation || 'unverified'})`,
        quote: citation.quote ? String(citation.quote) : null,
      })),
      closureNote: item.resolutionNote ? String(item.resolutionNote) : null,
    };
  });

  const reasons = handover.withheld?.byReason || {};

  return {
    recipientName,
    projectLabel,
    projectKey: snapshot.projectKey || null,
    viewLabel: viewer === 'reviewer' ? 'Reviewer copy' : 'Recipient copy',
    meta,
    summary: snapshot.generatedSummary || null,
    items,
    withheld:
      viewer === 'reviewer' && handover.withheld?.total > 0
        ? {
            total: handover.withheld.total,
            permissions: reasons.permissions || 0,
            authorPermissions: reasons.author_permissions || 0,
            template: reasons.template || 0,
            unverified: reasons.unverified || 0,
          }
        : null,
    alerts: (handover.alerts || []).map((alert) => ({
      severity: String(alert.severity || 'info').toLowerCase(),
      message: String(alert.message || ''),
    })),
    recommendations: (handover.recommendations || []).map((action) => ({
      priority: String(action.priority || 'medium').toLowerCase(),
      title: String(action.title || ''),
      reason: action.reason ? String(action.reason) : null,
    })),
  };
}

function drawCover(doc, model) {
  const width = contentWidth(doc);
  doc.save();
  doc.rect(0, 0, doc.page.width, 6).fill(COLORS.brand);
  doc.restore();
  doc.y = doc.page.margins.top - 12;

  writeText(doc, 'THREADLINE · HANDOVER', {
    font: 'bold',
    size: 8,
    color: COLORS.brand,
    characterSpacing: 1.6,
    width,
  });
  doc.moveDown(0.7);
  writeText(doc, `Handover for ${model.recipientName}`, {
    font: 'bold',
    size: 21,
    color: COLORS.ink,
    width,
  });
  doc.moveDown(0.4);
  writeText(
    doc,
    `A ${model.viewLabel.toLowerCase()} of ${model.items.length} approved item${
      model.items.length === 1 ? '' : 's'
    }, generated from the same permission-filtered view shown in the product.`,
    { size: 9.2, color: COLORS.inkMuted, width, lineGap: 1.5 },
  );
  doc.moveDown(0.9);
}

function drawMeta(doc, pairs) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const padX = 14;
  const padY = 12;
  const labelW = 82;
  const gap = 12;
  const rowGap = 6;
  const valueW = width - padX * 2 - labelW - gap;

  const rows = pairs.map(([label, value]) => {
    const labelH = measure(doc, label.toUpperCase(), {
      font: 'bold',
      size: 7.4,
      width: labelW,
    });
    const valueH = Math.max(
      measure(doc, value, { size: 9.4, width: valueW }),
      9.4 * 1.5,
    );
    return { label, value, height: Math.max(labelH, valueH) };
  });

  const height =
    padY * 2 +
    rows.reduce((sum, row) => sum + row.height, 0) +
    rowGap * (rows.length - 1);

  ensureSpace(doc, height + 12);
  const top = doc.y;
  doc.save();
  doc.roundedRect(left, top, width, height, 9).fill(COLORS.brandSoft);
  doc.restore();

  let y = top + padY;
  for (const row of rows) {
    writeTextAt(doc, row.label.toUpperCase(), left + padX, y + 1.4, {
      font: 'bold',
      size: 7.4,
      color: COLORS.inkMuted,
      characterSpacing: 0.6,
      width: labelW,
    });
    writeTextAt(doc, row.value, left + padX + labelW + gap, y, {
      size: 9.4,
      color: COLORS.ink,
      width: valueW,
    });
    y += row.height + rowGap;
  }

  doc.y = top + height;
  doc.x = left;
  doc.moveDown(0.9);
}

function section(doc, title, note, keepWith = 0) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  ensureSpace(doc, 46 + keepWith);
  doc.moveDown(0.9);
  doc.x = left;
  writeText(doc, title, { font: 'bold', size: 12.4, color: COLORS.ink, width });
  if (note) {
    writeText(doc, note, {
      size: 8.4,
      color: COLORS.inkMuted,
      width,
      lineGap: 1,
    });
  }
  doc.moveDown(0.3);
  doc.save();
  doc
    .moveTo(left, doc.y)
    .lineTo(left + width, doc.y)
    .lineWidth(0.7)
    .strokeColor(COLORS.line)
    .stroke();
  doc.restore();
  doc.moveDown(0.55);
}

function paragraph(doc, text, opts = {}) {
  const width = contentWidth(doc);
  const size = opts.size || 9.6;
  const height = measure(doc, text, { size, width, lineGap: opts.lineGap ?? 1.6 });
  ensureSpace(doc, height + 10);
  doc.x = doc.page.margins.left;
  writeText(doc, text, {
    size,
    color: COLORS.inkSoft,
    width,
    lineGap: 1.6,
    ...opts,
  });
  doc.moveDown(0.4);
}

function evidenceMetrics(doc, evidence, width) {
  const innerW = width - 24;
  const headH = measure(doc, evidence.heading, {
    font: 'bold',
    size: 8,
    width: innerW,
  });
  const quoteH = evidence.quote
    ? measure(doc, evidence.quote, { size: 8.8, width: innerW, lineGap: 1.3 })
    : 0;
  return {
    innerW,
    headH,
    quoteH,
    height: 18 + headH + (evidence.quote ? quoteH + 5 : 0),
  };
}

function drawEvidence(doc, evidence, x, width) {
  const padX = 12;
  const padY = 9;
  const { innerW, headH, height } = evidenceMetrics(doc, evidence, width);

  ensureSpace(doc, height + 6);
  const top = doc.y;
  doc.save();
  doc.rect(x, top, width, height).fill(COLORS.evidence);
  doc.rect(x, top, 2.4, height).fill(COLORS.brand);
  doc.restore();

  writeTextAt(doc, evidence.heading, x + padX, top + padY, {
    font: 'bold',
    size: 8,
    color: COLORS.inkMuted,
    width: innerW,
  });
  if (evidence.quote) {
    writeTextAt(doc, evidence.quote, x + padX, top + padY + headH + 5, {
      size: 8.8,
      color: COLORS.inkSoft,
      width: innerW,
      lineGap: 1.3,
    });
  }

  doc.y = top + height;
  doc.x = x;
  doc.moveDown(0.35);
}

function drawItem(doc, item) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const numberW = 24;
  const bodyW = width - numberW;

  const statementH = measure(doc, item.statement, {
    font: 'bold',
    size: 10.6,
    width: bodyW,
    lineGap: 1,
  });
  const factsText = item.facts.join('   ·   ');
  const factsH = item.facts.length
    ? measure(doc, factsText, { size: 8.5, width: bodyW, lineGap: 1 })
    : 0;
  const firstEvidence = item.evidence[0]
    ? evidenceMetrics(doc, item.evidence[0], bodyW)
    : null;

  ensureSpace(
    doc,
    statementH + factsH + 22 + (firstEvidence ? firstEvidence.height + 6 : 0),
  );
  doc.moveDown(0.4);
  const top = doc.y;

  writeTextAt(doc, `${item.index}.`, left, top, {
    font: 'bold',
    size: 10.6,
    color: COLORS.brand,
    width: numberW,
  });
  writeTextAt(doc, item.statement, left + numberW, top, {
    font: 'bold',
    size: 10.6,
    color: COLORS.ink,
    width: bodyW,
    lineGap: 1,
  });

  let cursor = top + statementH + 3;
  if (item.facts.length) {
    writeTextAt(doc, factsText, left + numberW, cursor, {
      size: 8.5,
      color: COLORS.inkMuted,
      width: bodyW,
      lineGap: 1,
    });
    cursor += factsH + 4;
  }
  doc.y = cursor;
  doc.x = left + numberW;

  for (const evidence of item.evidence) {
    drawEvidence(doc, evidence, left + numberW, bodyW);
  }

  if (item.closureNote) {
    const note = `Closure note: ${item.closureNote}`;
    const noteH = measure(doc, note, { size: 8.8, width: bodyW, lineGap: 1.2 });
    ensureSpace(doc, noteH + 8);
    doc.x = left + numberW;
    writeText(doc, note, {
      size: 8.8,
      color: COLORS.inkSoft,
      width: bodyW,
      lineGap: 1.2,
    });
  }

  doc.moveDown(0.7);
}

function drawWithheld(doc, withheld) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const padX = 14;
  const padY = 12;
  const innerW = width - padX * 2;
  const text =
    `${withheld.total} item${withheld.total === 1 ? '' : 's'} withheld: ` +
    `permissions ${withheld.permissions}, author access ${withheld.authorPermissions}, ` +
    `template ${withheld.template}, unverified evidence ${withheld.unverified}. ` +
    'Details are intentionally omitted.';
  const textH = measure(doc, text, { size: 9.4, width: innerW, lineGap: 1.6 });
  const height = padY * 2 + textH;

  section(doc, 'Withheld from this view', null, height + 16);
  ensureSpace(doc, height + 8);
  const top = doc.y;
  doc.save();
  doc.roundedRect(left, top, width, height, 8).fill(COLORS.warnBg);
  doc
    .roundedRect(left, top, width, height, 8)
    .lineWidth(0.8)
    .strokeColor(COLORS.warnLine)
    .stroke();
  doc.restore();

  writeTextAt(doc, text, left + padX, top + padY, {
    size: 9.4,
    color: COLORS.warnText,
    width: innerW,
    lineGap: 1.6,
  });

  doc.y = top + height;
  doc.x = left;
  doc.moveDown(0.7);
}

function drawAlert(doc, alert) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const labelW = 58;
  const messageW = width - labelW - 8;
  const messageH = measure(doc, alert.message, {
    size: 9.2,
    width: messageW,
    lineGap: 1.2,
  });
  const tone =
    alert.severity === 'critical'
      ? COLORS.critical
      : alert.severity === 'warning'
        ? COLORS.warn
        : COLORS.inkMuted;

  ensureSpace(doc, messageH + 14);
  const top = doc.y;
  writeTextAt(doc, alert.severity.toUpperCase(), left, top + 1, {
    font: 'bold',
    size: 7.8,
    color: tone,
    characterSpacing: 0.5,
    width: labelW,
  });
  writeTextAt(doc, alert.message, left + labelW + 8, top, {
    size: 9.2,
    color: COLORS.inkSoft,
    width: messageW,
    lineGap: 1.2,
  });

  doc.y = top + Math.max(messageH, 11) + 6;
  doc.x = left;
}

function drawRecommendation(doc, action) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const titleW = width - 70;
  const titleH = measure(doc, action.title, {
    font: 'bold',
    size: 9.6,
    width: titleW,
    lineGap: 1,
  });
  const reasonH = action.reason
    ? measure(doc, action.reason, { size: 8.6, width: titleW, lineGap: 1.2 })
    : 0;

  ensureSpace(doc, titleH + reasonH + 16);
  const top = doc.y;
  writeTextAt(doc, action.priority.toUpperCase(), left, top + 1, {
    font: 'bold',
    size: 7.8,
    color: COLORS.brand,
    characterSpacing: 0.5,
    width: 62,
  });
  writeTextAt(doc, action.title, left + 70, top, {
    font: 'bold',
    size: 9.6,
    color: COLORS.ink,
    width: titleW,
    lineGap: 1,
  });

  let cursor = top + titleH + 2;
  if (action.reason) {
    writeTextAt(doc, action.reason, left + 70, cursor, {
      size: 8.6,
      color: COLORS.inkMuted,
      width: titleW,
      lineGap: 1.2,
    });
    cursor += reasonH;
  }

  doc.y = cursor + 6;
  doc.x = left;
}

function drawFooters(doc, model) {
  const range = doc.bufferedPageRange();
  const savedBottom = doc.page.margins.bottom;

  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    // Text below the bottom margin would otherwise start a new page.
    doc.page.margins.bottom = 0;

    const left = doc.page.margins.left;
    const width = contentWidth(doc);
    const y = doc.page.height - 44;

    doc.save();
    doc
      .moveTo(left, y - 10)
      .lineTo(left + width, y - 10)
      .lineWidth(0.6)
      .strokeColor(COLORS.line)
      .stroke();
    doc.restore();

    writeTextAt(
      doc,
      `Threadline · permission-filtered export · ${model.projectLabel}`,
      left,
      y,
      { size: 7.6, color: COLORS.inkMuted, width: width - 96 },
    );
    writeTextAt(doc, `Page ${index + 1} of ${range.count}`, left + width - 96, y, {
      size: 7.6,
      color: COLORS.inkMuted,
      width: 96,
      align: 'right',
    });

    doc.page.margins.bottom = savedBottom;
  }
}

/**
 * Renders the handover as a self-contained A4 PDF. The caller supplies the
 * already permission-filtered view, so nothing outside that view can appear in
 * the document.
 */
export async function renderHandoverPdf({ handover, projectName, viewer }) {
  const model = buildHandoverExport({ handover, projectName, viewer });

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 64, bottom: 72, left: 54, right: 54 },
    bufferPages: true,
    info: {
      Title: `Handover for ${model.recipientName}`,
      Author: 'Threadline',
      Subject: `Permission-filtered ${model.viewLabel.toLowerCase()} for ${model.projectLabel}`,
      Keywords: 'handover, threadline, permission-filtered',
      Creator: 'Threadline',
      Producer: 'Threadline',
    },
  });

  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.registerFont('body', path.join(FONT_DIR, FONTS.body));
  doc.registerFont('bold', path.join(FONT_DIR, FONTS.bold));
  doc.registerFont('deva', path.join(FONT_DIR, FONTS.deva));

  drawCover(doc, model);
  drawMeta(doc, model.meta);

  if (model.summary) {
    section(doc, 'Summary');
    paragraph(doc, model.summary);
  }

  section(doc, `Items (${model.items.length})`, null, 70);
  if (model.items.length === 0) {
    paragraph(doc, 'No approved items were included in this view.');
  }
  for (const item of model.items) drawItem(doc, item);

  if (model.withheld) drawWithheld(doc, model.withheld);

  if (model.alerts.length > 0) {
    section(doc, 'Alerts', null, 34);
    for (const alert of model.alerts) drawAlert(doc, alert);
  }

  if (model.recommendations.length > 0) {
    section(doc, 'Suggested next actions', 'Inferred suggestions, not extracted facts.', 46);
    for (const action of model.recommendations) drawRecommendation(doc, action);
  }

  ensureSpace(doc, 48);
  doc.moveDown(0.8);
  paragraph(
    doc,
    `Generated by Threadline for ${model.projectKey || model.projectLabel}. ` +
      'Ask the project team if anything here is unclear; the share link accepts notes from the recipient.',
    { size: 8.6, color: COLORS.inkMuted, lineGap: 1.4 },
  );

  drawFooters(doc, model);
  doc.end();

  return done;
}
