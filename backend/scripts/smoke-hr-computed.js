// Throwaway end-to-end smoke test for HR computed fields. Creates a real
// (committed) ticket on the Technician form, writes John Doe / 2000-03-12 as
// inputs, runs the post-commit recompute path, reads the derived values back,
// asserts them, then deletes the ticket (cascade cleans values). FORM arg:
// 17 = Technician (expect g2_username jdoe312), 18 = Desked (expect PCJODOE).
const { pool } = require('../db/pool');
const tcf = require('../services/ticketCustomFields');

const FORM = Number(process.argv[2] || 17);

(async () => {
  const c = await pool.connect();
  let ticketId;
  try {
    const ref = `SMOKE-${FORM}-${process.pid}`;
    const ins = await c.query(
      `INSERT INTO tickets (internal_ref, project_id, form_id, submitted_by, title)
       VALUES ($1, 7, $2, 1, 'smoke test') RETURNING id`,
      [ref, FORM]
    );
    ticketId = ins.rows[0].id;

    // Inputs (committed so the recompute path's buildContext can read them).
    await c.query(`INSERT INTO custom_field_values (def_id, ticket_id, value_text) VALUES (26,$1,'John'),(27,$1,'Doe')`, [ticketId]);
    await c.query(`INSERT INTO custom_field_values (def_id, ticket_id, value_date) VALUES (25,$1,'2000-03-12')`, [ticketId]);

    const results = await tcf.recomputeForTicket(pool, ticketId);
    const out = {};
    for (const r of results) out[r.slug] = r.value;
    console.log('recompute results:', out);

    const vals = await tcf.readValues(pool, ticketId, { reveal: true });
    const derived = {};
    for (const v of vals) if (['hr-upn', 'hr-g2_username', 'hr-g2_desk_username', 'hr-initial_password'].includes(v.slug)) derived[v.slug] = v.value;
    console.log('stored derived values:', derived);

    const want = FORM === 18
      ? { 'hr-upn': 'jdoe', 'hr-g2_desk_username': 'PCJODOE', 'hr-initial_password': 'Jd^0312#' }
      : { 'hr-upn': 'jdoe', 'hr-g2_username': 'jdoe312', 'hr-initial_password': 'Jd^0312#' };
    let ok = true;
    for (const [k, v] of Object.entries(want)) {
      const pass = derived[k] === v;
      if (!pass) ok = false;
      console.log(`  ${pass ? 'PASS' : 'FAIL'} ${k} = ${JSON.stringify(derived[k])}${pass ? '' : ` (want ${v})`}`);
    }
    console.log(ok ? '\nALL PASS' : '\nFAILED');
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    console.error('smoke failed:', e.message);
    process.exitCode = 1;
  } finally {
    if (ticketId) await c.query('DELETE FROM tickets WHERE id = $1', [ticketId]).catch(() => {});
    c.release();
    await pool.end();
  }
})();
