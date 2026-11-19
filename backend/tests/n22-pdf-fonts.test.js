import { describe, expect, it } from 'vitest';
import { extractText, getDocumentProxy } from 'unpdf';
import { renderHandoverPdf } from '../src/services/handover/export.js';

const STATEMENTS = [
  'குழு புதிய கணக்கை அங்கீகரித்தது',
  'দলটি নতুন অ্যাকাউন্ট অনুমোদন করেছে',
  'ટીમે નવું ખાતું મંજૂર કર્યું',
  'సమూహం కొత్త ఖాతాను ఆమోదించింది',
];

describe('N22 handover PDF scripts', () => {
  it('renders Tamil, Bengali, Gujarati and Telugu instead of missing glyphs', async () => {
    const pdf = await renderHandoverPdf({
      handover: {
        status: 'in_review',
        version: 1,
        recipientSnapshot: { name: 'Ananya Rao' },
        snapshot: { projectName: 'Atlas' },
        items: STATEMENTS.map((statement, index) => ({
          type: 'decision',
          status: 'active',
          statement,
          key: `script-${index}`,
          citations: [],
        })),
      },
      projectName: 'Atlas',
      viewer: 'recipient',
    });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const doc = await getDocumentProxy(new Uint8Array(pdf));
    const { text } = await extractText(doc, { mergePages: true });
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).not.toContain('\uFFFD');

    // The PDF must embed a real Noto face for each script, not fall back to the
    // Latin font that has no glyphs for it.
    const raw = pdf.toString('latin1');
    for (const family of ['NotoSansTamil', 'NotoSansBengali', 'NotoSansGujarati', 'NotoSansTelugu']) {
      expect(raw).toContain(family);
    }

    // Shaping can reorder or decompose a cluster in extracted text, so require
    // that the great majority of the characters survive rather than an exact
    // string match.
    for (const statement of STATEMENTS) {
      const chars = [...statement].filter((entry) => entry.trim());
      const present = chars.filter((char) => flat.includes(char)).length;
      expect(present / chars.length, statement).toBeGreaterThan(0.6);
    }
  });

  it('shapes Devanagari matras that fontkit 2.0.4 crashed on', async () => {
    // The live export threw on these very clusters: fontkit 2.0.4 read a null
    // mark anchor while positioning a matra and the whole PDF failed with 500.
    const hindi = [
      'भुगतान विभाजन की योजना अंतिम है।',
      'लाइसेंस शर्तों की समीक्षा करें।',
      'ऑपरेटर बदलाव अभी भी खुला है।',
    ];

    const pdf = await renderHandoverPdf({
      handover: {
        status: 'shared',
        version: 2,
        recipientSnapshot: { name: 'Ananya Rao' },
        snapshot: { projectName: 'Atlas' },
        items: hindi.map((statement, index) => ({
          type: 'decision',
          status: 'active',
          statement,
          key: `hindi-${index}`,
          citations: [{ sourceName: 'handover-notes-hi.md', quote: statement, validation: 'exact' }],
        })),
      },
      projectName: 'Atlas',
      viewer: 'recipient',
    });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const doc = await getDocumentProxy(new Uint8Array(pdf));
    const { text } = await extractText(doc, { mergePages: true });
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).not.toContain('\uFFFD');
    expect(pdf.toString('latin1')).toContain('NotoSansDevanagari');

    for (const statement of hindi) {
      const chars = [...statement].filter((entry) => /[\u0900-\u097F]/.test(entry));
      const present = chars.filter((char) => flat.includes(char)).length;
      expect(present / chars.length, statement).toBeGreaterThan(0.6);
    }
  });
});
