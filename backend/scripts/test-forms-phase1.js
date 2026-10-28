// Self-contained functional test for Phase 1 custom forms. Creates temp
// project/category/form/fields, exercises the validate→write→read logic
// (including the cross-form bleed guard + sensitive encryption), then rolls
// everything back. Read-only net effect. Run inside the backend container:
//   docker exec -w /app resolvd-backend node scripts/test-forms-phase1.js
const { pool } = require('../db/pool');
const tcf = require('../services/ticketCustomFields');
const { applyTags } = require('../services/cannedRender');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`); } }

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Temp project + category + two forms (HR Onboarding, generic SR).
    const proj = (await client.query(`INSERT INTO projects (name, prefix) VALUES ('ZZ Test HR','ZZTESTHR') RETURNING id`)).rows[0];
    const cat = (await client.query(`INSERT INTO ticket_categories (project_id, name) VALUES ($1,'HR') RETURNING id`, [proj.id])).rows[0];
    const onboard = (await client.query(`INSERT INTO ticket_forms (category_id, name) VALUES ($1,'Onboarding') RETURNING id`, [cat.id])).rows[0];
    const srForm = (await client.query(`INSERT INTO ticket_forms (category_id, name) VALUES ($1,'Generic SR') RETURNING id`, [cat.id])).rows[0];

    // Two project-local defs: a required username + a sensitive temp password.
    const uname = (await client.query(`INSERT INTO custom_field_defs (entity_type, slug, label, type, project_id) VALUES ('ticket','zztesthr-username','Username','text',$1) RETURNING id`, [proj.id])).rows[0];
    const pwd = (await client.query(`INSERT INTO custom_field_defs (entity_type, slug, label, type, project_id, sensitive) VALUES ('ticket','zztesthr-temp_password','Temp Password','text',$1,TRUE) RETURNING id`, [proj.id])).rows[0];

    // Bind both to Onboarding (username required); bind NOTHING to Generic SR.
    await client.query(`INSERT INTO ticket_form_fields (form_id, field_def_id, required, sort_order) VALUES ($1,$2,TRUE,0)`, [onboard.id, uname.id]);
    await client.query(`INSERT INTO ticket_form_fields (form_id, field_def_id, required, sort_order) VALUES ($1,$2,FALSE,1)`, [onboard.id, pwd.id]);

    console.log('\n[1] Required validation on the chosen form:');
    let r = await tcf.validateForForm(client, onboard.id, []); // nothing supplied
    ok(r.missing.includes('zztesthr-username'), 'missing required username flagged when empty');
    r = await tcf.validateForForm(client, onboard.id, [{ def_id: uname.id, value: 'jdoe' }]);
    ok(r.missing.length === 0, 'no missing when required username supplied');
    ok(r.coerced.length === 1 && r.coerced[0].value === 'jdoe', 'username coerced through');

    console.log('\n[2] Anti-bleed: Generic SR has no required fields:');
    r = await tcf.validateForForm(client, srForm.id, []);
    ok(r.missing.length === 0, 'Generic SR requires nothing despite HR fields existing in same project');

    console.log('\n[3] Write + read round-trip (incl. sensitive encryption):');
    const tk = (await client.query(`INSERT INTO tickets (project_id, internal_ref, title, form_id) VALUES ($1,'ZZTESTHR-0001','test', $2) RETURNING id`, [proj.id, onboard.id])).rows[0];
    const { coerced } = await tcf.validateForForm(client, onboard.id, [{ def_id: uname.id, value: 'jdoe' }, { def_id: pwd.id, value: 'S3cr3t!' }]);
    await tcf.writeValues(client, tk.id, coerced);
    const mode = (await client.query(`SELECT mode FROM encryption_settings WHERE id = 1`)).rows[0]?.mode || 'off';
    const rawPwd = (await client.query(`SELECT value_text, value_text_enc FROM custom_field_values WHERE ticket_id=$1 AND def_id=$2`, [tk.id, pwd.id])).rows[0];
    if (mode && mode !== 'off') {
      ok(rawPwd.value_text_enc != null && rawPwd.value_text == null, `sensitive value stored encrypted (mode=${mode})`);
    } else {
      ok(rawPwd.value_text === 'S3cr3t!', `sensitive value stored plaintext (mode=off) — UI masks`);
    }
    const masked = await tcf.readValues(client, tk.id, { reveal: false });
    const pwdMasked = masked.find((m) => m.slug === 'zztesthr-temp_password');
    ok(pwdMasked && pwdMasked.value === '••••••', 'sensitive masked for non-handler read');
    const revealed = await tcf.readValues(client, tk.id, { reveal: true });
    const pwdReveal = revealed.find((m) => m.slug === 'zztesthr-temp_password');
    ok(pwdReveal && pwdReveal.value === 'S3cr3t!', 'sensitive revealed for handler read');
    const unameRead = revealed.find((m) => m.slug === 'zztesthr-username');
    ok(unameRead && unameRead.value === 'jdoe', 'non-sensitive value reads back');

    console.log('\n[4] Type coercion rejects bad input:');
    const numDef = (await client.query(`INSERT INTO custom_field_defs (entity_type, slug, label, type, project_id) VALUES ('ticket','zztesthr-count','Count','number',$1) RETURNING id`, [proj.id])).rows[0];
    await client.query(`INSERT INTO ticket_form_fields (form_id, field_def_id, required) VALUES ($1,$2,FALSE)`, [onboard.id, numDef.id]);
    let threw = false;
    try { await tcf.validateForForm(client, onboard.id, [{ def_id: uname.id, value: 'jdoe' }, { def_id: numDef.id, value: 'not-a-number' }]); }
    catch (e) { threw = e.status === 400; }
    ok(threw, 'non-numeric value to number field rejected with 400');

    console.log('\n[5] Agent-only field visibility gating:');
    const apwd = (await client.query(`INSERT INTO custom_field_defs (entity_type, slug, label, type, project_id, agent_only) VALUES ('ticket','zztesthr-agentpw','Agent PW','text',$1,TRUE) RETURNING id`, [proj.id])).rows[0];
    await client.query(`INSERT INTO ticket_form_fields (form_id, field_def_id, required, sort_order) VALUES ($1,$2,TRUE,5)`, [onboard.id, apwd.id]);
    let sv = await tcf.validateForForm(client, onboard.id, [{ def_id: uname.id, value: 'jdoe' }], { agentView: false });
    ok(!sv.missing.includes('zztesthr-agentpw'), 'agent-only required field NOT required of submitter (hidden)');
    let av = await tcf.validateForForm(client, onboard.id, [{ def_id: uname.id, value: 'jdoe' }], { agentView: true });
    ok(av.missing.includes('zztesthr-agentpw'), 'agent-only required field IS enforced for agent');

    console.log('\n[6] Agent fills agent-only field on existing ticket (PATCH path):');
    const changed = await tcf.applyTicketPatch(client, tk.id, onboard.id, [{ def_id: apwd.id, value: 'TmpAbc1' }]);
    ok(changed.includes('zztesthr-agentpw'), 'applyTicketPatch reports the changed slug');
    const rev = await tcf.readValues(client, tk.id, { reveal: true });
    ok(rev.find((x) => x.slug === 'zztesthr-agentpw')?.value === 'TmpAbc1', 'agent-only value persisted + reads back');

    console.log('\n[7] Canned {field.<slug>} tag (hyphen-tolerant):');
    ok(applyTags('Pwd: {field.zztesthr-temp_password} end', { field: { 'zztesthr-temp_password': 'S3cr3t!' } }) === 'Pwd: S3cr3t! end', 'hyphenated {field.<slug>} resolves');
    ok(applyTags('{field.unknown-x}', { field: {} }) === '{field.unknown-x}', 'unknown {field.<slug>} passes through unchanged');

    await client.query('ROLLBACK');
    console.log(`\nRESULT: ${pass} passed, ${fail} failed (all temp data rolled back)`);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('TEST ERROR', e);
    process.exit(1);
  } finally {
    client.release();
  }
})();
