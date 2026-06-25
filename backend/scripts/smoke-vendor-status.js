// Throwaway smoke test for vendor-reply status automation. Creates an
// External-Escalation ticket with a vendor ref, runs applyVendorReplyStatus
// for ack then completion, asserts external/internal transitions, cleans up.
const { pool } = require('../db/pool');
const ar = require('../services/autoResolve');

const read = async (id) => (await pool.query(
  'SELECT internal_status, external_status FROM tickets WHERE id=$1', [id])).rows[0];

(async () => {
  let id;
  let ok = true;
  const check = (label, got, want) => {
    const pass = JSON.stringify(got) === JSON.stringify(want);
    if (!pass) ok = false;
    console.log(`  ${pass ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(got)}${pass ? '' : ` (want ${JSON.stringify(want)})`}`);
  };
  try {
    const ins = await pool.query(
      `INSERT INTO tickets (internal_ref, internal_status, external_status, external_ticket_ref, title, submitted_by)
       VALUES ($1,'External Escalation','Unacknowledged','VEND-${process.pid}','vendor smoke',1) RETURNING id`,
      [`VSMOKE-${process.pid}`]
    );
    id = ins.rows[0].id;

    // 1) Acknowledgement → external In Progress, internal UNCHANGED.
    const r1 = await ar.applyVendorReplyStatus({ ticketId: id, replyBody: 'We are confirming receipt and will investigate.', actorUserId: 1 });
    check('ack handled', r1.handled, true);
    check('ack classification', r1.classification, 'acknowledged');
    check('after ack', await read(id), { internal_status: 'External Escalation', external_status: 'In Progress' });

    // 2) Completion → external Resolved, internal Pending Review.
    const r2 = await ar.applyVendorReplyStatus({ ticketId: id, replyBody: 'The work has been completed on our end.', actorUserId: 1 });
    check('done handled', r2.handled, true);
    check('done classification', r2.classification, 'completed');
    check('after completion', await read(id), { internal_status: 'Pending Review', external_status: 'Resolved' });

    // 3) Non-engaged ticket (no ref, normal status) → not handled.
    const ins2 = await pool.query(
      `INSERT INTO tickets (internal_ref, internal_status, external_status, title, submitted_by)
       VALUES ($1,'Open','Unacknowledged','no vendor',1) RETURNING id`, [`VSMOKE2-${process.pid}`]);
    const id2 = ins2.rows[0].id;
    const r3 = await ar.applyVendorReplyStatus({ ticketId: id2, replyBody: 'acknowledged', actorUserId: 1 });
    check('non-engaged not handled', r3.handled, false);
    await pool.query('DELETE FROM tickets WHERE id=$1', [id2]);

    console.log(ok ? '\nALL PASS' : '\nFAILED');
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    console.error('smoke failed:', e.message);
    process.exitCode = 1;
  } finally {
    if (id) await pool.query('DELETE FROM tickets WHERE id=$1', [id]).catch(() => {});
    await pool.end();
  }
})();
