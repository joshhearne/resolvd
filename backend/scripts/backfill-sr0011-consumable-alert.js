// One-shot: replay the ingest-time consumable-match alert for SR-0011.
// Posts the OOS system comment + admin notification that would have
// fired had the new alertIngest logic been live at promotion time.

const { pool, transaction } = require('../db/pool');
const { systemComment } = require('../services/ticketHelpers');
const { notifyManagersAndAdmins } = require('../services/notifications');

(async () => {
  try {
    const ticketRef = 'SR-0011';
    const partTag = '006R04401';
    const t = await pool.query(
      `SELECT id, internal_ref FROM tickets WHERE internal_ref = $1`,
      [ticketRef]
    );
    if (!t.rows[0]) { console.error('ticket not found'); process.exit(1); }
    const ticketId = t.rows[0].id;

    const cm = await pool.query(
      `SELECT id, part_no, title, current_stock, low_stock_threshold,
              reorder_qty, purchase_url, vendor_part_no, is_metered,
              vendor_company_id
         FROM consumables
        WHERE is_archived = FALSE
          AND (part_no ILIKE $1 OR vendor_part_no ILIKE $1)
        ORDER BY (CASE WHEN part_no ILIKE $1 THEN 0 ELSE 1 END), id ASC
        LIMIT 1`,
      [partTag]
    );
    const cons = cm.rows[0];
    if (!cons) { console.error('consumable not matched'); process.exit(1); }

    const stock = Number(cons.current_stock || 0);
    const thr = Number(cons.low_stock_threshold || 0);
    const isOOS = stock <= 0;
    const isLow = !isOOS && thr > 0 && stock <= thr;
    const gaps = [];
    if (!cons.vendor_part_no) gaps.push('vendor P/N');
    if (!cons.reorder_qty) gaps.push('restock qty');
    if (!cons.is_metered && !cons.purchase_url) gaps.push('purchase URL');
    if (!cons.vendor_company_id) gaps.push('vendor company');
    const gapLine = gaps.length
      ? `\n\n📝 **Missing data on the consumable record:** ${gaps.join(', ')}. Fix under Admin → Consumables → ${cons.part_no}.`
      : '';
    const restockCta = cons.is_metered
      ? `Use canned response "Consumable restock — metered / leased printer" to dispatch via service agreement.`
      : (cons.purchase_url
          ? `**Restock URL:** ${cons.purchase_url}\n**Vendor P/N:** ${cons.vendor_part_no || cons.part_no}\nUse canned response "Consumable restock — self-serve RFQ".`
          : `No purchase URL on file. Use canned response "Consumable restock — self-serve RFQ" or add a URL.`);

    await transaction(async (client) => {
      if (isOOS) {
        await systemComment(
          client, ticketId,
          `⚠ **${cons.part_no} (${cons.title || ''}) is out of stock.** Auto-matched from alert tag \`part.number:${partTag}\` (backfilled).\n\n${restockCta}${gapLine}`
        );
        await notifyManagersAndAdmins(client, {
          type: 'consumable_out_of_stock',
          title: `Out of stock: ${cons.part_no}`,
          body: `Backfill: ${ticketRef} matched ${cons.part_no} but stock is 0.`,
          data: {
            ticket_id: ticketId,
            consumable_id: cons.id,
            part_no: cons.part_no,
            is_metered: cons.is_metered,
            purchase_url: cons.purchase_url,
            vendor_part_no: cons.vendor_part_no,
            reorder_qty: cons.reorder_qty,
            missing: gaps,
            backfill: true,
          },
        });
      } else if (isLow) {
        await systemComment(
          client, ticketId,
          `🟡 **Low stock:** ${cons.part_no} at ${stock}/${thr}. Auto-matched from alert tag \`part.number:${partTag}\` (backfilled).\n\n${restockCta}${gapLine}`
        );
        await notifyManagersAndAdmins(client, {
          type: 'consumable_low_stock',
          title: `Low stock: ${cons.part_no} at ${stock}/${thr}`,
          body: `Backfill: ${ticketRef} matched ${cons.part_no} (low).`,
          data: {
            ticket_id: ticketId,
            consumable_id: cons.id,
            part_no: cons.part_no,
            current_stock: stock,
            low_stock_threshold: thr,
            is_metered: cons.is_metered,
            purchase_url: cons.purchase_url,
            vendor_part_no: cons.vendor_part_no,
            reorder_qty: cons.reorder_qty,
            missing: gaps,
            backfill: true,
          },
        });
      } else if (gaps.length) {
        await systemComment(
          client, ticketId,
          `📝 **${cons.part_no}** auto-matched from alert (backfilled). Stock OK (${stock}), missing: ${gaps.join(', ')}.`
        );
      } else {
        console.log('no condition triggered — stock fine, no gaps');
      }
    });

    console.log(`backfilled SR-0011 → consumable ${cons.part_no} (stock ${stock}, threshold ${thr}, OOS=${isOOS}, low=${isLow})`);
    process.exit(0);
  } catch (err) {
    console.error('backfill failed:', err);
    process.exit(1);
  }
})();
