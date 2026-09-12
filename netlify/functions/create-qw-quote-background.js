// netlify/functions/create-qw-quote-background.js
//
// Netlify BACKGROUND FUNCTION. Any file ending in `-background.js` gets a
// 15-minute execution budget instead of the default 26 seconds, and always
// returns 202 Accepted to the caller. There is no synchronous response to
// forward to the browser — the caller (create-qw-quote.js) already returned
// the header info to the mobile UI.
//
// This function does the slow parts of a big quote:
//   1. Bulk-warm the product cache with 'in' filter queries.
//   2. Look up each rollup + custom line, build the DocumentItem plan.
//   3. Sequentially insert every line (QW rejects concurrent inserts to the
//      same DocumentHeader).
//   4. Trigger send-from-rep to deliver the QW-attributed PDF from the rep.
//
// Diagnostics land in Netlify function logs — nothing is returned to the
// browser. Failures do NOT roll back the header; the mobile UI already knows
// the DocNo and any partial inserts remain visible in QW.

import {
  QW_BASE_DEFAULT,
  buildLinePlan,
  insertLinesSequential,
  emailRep,
  totalPanelItems,
} from './_qw-shared.mjs';

export const handler = async (event) => {
  const t0 = Date.now();
  const { QW_API_KEY, QW_API_BASE } = process.env;
  const base = QW_API_BASE || QW_BASE_DEFAULT;
  const siteUrl = process.env.URL || process.env.DEPLOY_URL;
  if (!QW_API_KEY) {
    console.error('create-qw-quote-background: QW_API_KEY missing');
    return { statusCode: 500 };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { console.error('bad json', e); return { statusCode: 400 }; }

  const { docId, docNo, rep, customer, panels } = payload;
  if (!docId || !rep || !panels) {
    console.error('background: missing required fields', { hasDocId: !!docId, hasRep: !!rep, hasPanels: !!panels });
    return { statusCode: 400 };
  }
  const itemCount = totalPanelItems(panels);
  console.log(`bg-quote start docId=${docId} docNo=${docNo} rep=${rep} items=${itemCount}`);

  const diag = {
    productLookups: 0,
    productHits: 0,
    productMisses: [],
  };

  // Build + insert lines.
  try {
    const plan = await buildLinePlan(base, QW_API_KEY, panels, diag);
    console.log(`bg-quote docNo=${docNo} plan=${plan.length} prewarmed=${diag.bulkPrewarmed} lookups=${diag.productLookups} hits=${diag.productHits} misses=${diag.productMisses.length}`);
    await insertLinesSequential(base, QW_API_KEY, docId, plan, diag);
    console.log(`bg-quote docNo=${docNo} inserted=${diag.linesInserted}/${diag.linesPlanned} errors=${diag.insertErrors.length}`);
    if (diag.insertErrors.length) {
      console.warn(`bg-quote docNo=${docNo} insertErrors:`, JSON.stringify(diag.insertErrors.slice(0, 10)));
    }
  } catch (e) {
    console.error(`bg-quote docNo=${docNo} plan/insert failed:`, e.message);
  }

  // Send the PDF via QW (or SMTP fallback). The header already exists so this
  // works even if some line inserts failed.
  try {
    const quoteUrl = `https://na.quotewerks.com/#/documents/${docId}`;
    const mail = await emailRep({ rep, customer, docNo, docId, quoteUrl, panels, base, apiKey: QW_API_KEY, siteUrl });
    console.log(`bg-quote docNo=${docNo} mail:`, JSON.stringify({
      sent: mail?.sent, via: mail?.via, to: mail?.to,
      attachments: mail?.attachments, emailSource: mail?.emailSource,
    }));
  } catch (e) {
    console.error(`bg-quote docNo=${docNo} email failed:`, e.message);
  }

  console.log(`bg-quote done docNo=${docNo} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { statusCode: 202 };
};
