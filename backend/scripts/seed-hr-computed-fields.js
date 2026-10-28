// Seed the four HR-onboarding computed (formula) custom fields and, when the
// HR project has exactly one form, bind them to it. Idempotent: a def whose
// slug already exists in the project is left untouched (skipped, not updated —
// edit those in Admin → Forms).
//
// Assumes the human-input fields already exist with slugs:
//   hr-first_name, hr-last_name, hr-birthdate
//
// Run:  node backend/scripts/seed-hr-computed-fields.js [PROJECT_PREFIX]
//       (PROJECT_PREFIX defaults to HR)

const { pool } = require('../db/pool');
const formula = require('../services/formula');

const PREFIX = (process.argv[2] || 'HR').toUpperCase();

// label drives the slug via the same hr-<slug> convention; we set slug
// explicitly here to stay deterministic.
const DEFS = [
  {
    slug: 'hr-upn', label: 'UPN', sensitive: false,
    formula: `lower( slice({field.hr-first_name},0,1) ~ {field.hr-last_name} )`,
    help_text: 'AD / M365 UPN — first initial + last name (e.g. jdoe).',
  },
  {
    slug: 'hr-g2_username', label: 'G2 Username', sensitive: false,
    formula: `lower( slice({field.hr-first_name},0,1) ~ {field.hr-last_name} ) ~ datepart({field.hr-birthdate},"M") ~ datepart({field.hr-birthdate},"D")`,
    help_text: 'IDS G2 Astra username — UPN + birth month/day, unpadded (e.g. jdoe312).',
  },
  {
    slug: 'hr-initial_password', label: 'Initial Password', sensitive: true,
    formula: `upper(slice({field.hr-first_name},0,1)) ~ lower(slice({field.hr-last_name},0,1)) ~ "^" ~ datepart({field.hr-birthdate},"MM") ~ datepart({field.hr-birthdate},"DD") ~ "#"`,
    help_text: 'Initial password — Up + low + ^ + MMDD + # (e.g. Jd^0312#).',
  },
  {
    slug: 'hr-g2_desk_username', label: 'G2 Desk Username', sensitive: false,
    formula: `"PC" ~ upper( if( len({field.hr-last_name})>=4, slice({field.hr-first_name},0,1) ~ slice({field.hr-last_name},0,4), slice({field.hr-first_name},0,5-len({field.hr-last_name})) ~ {field.hr-last_name} ) )`,
    help_text: 'Desked G2 username — PC + 5 chars (first initial + last, overflow from first; e.g. PCJODOE).',
  },
];

(async () => {
  const client = await pool.connect();
  try {
    const proj = await client.query('SELECT id, prefix FROM projects WHERE upper(prefix) = $1', [PREFIX]);
    if (!proj.rows[0]) throw new Error(`No project with prefix "${PREFIX}". Pass the right prefix as argv[1].`);
    const projectId = proj.rows[0].id;
    console.log(`Project ${PREFIX} = id ${projectId}`);

    // Pre-flight: every formula must be syntactically valid.
    for (const d of DEFS) {
      const v = formula.validate(d.formula);
      if (!v.ok) throw new Error(`formula for ${d.slug} invalid: ${v.error}`);
    }

    const defIds = [];
    for (const d of DEFS) {
      const ex = await client.query(
        'SELECT id, computed FROM custom_field_defs WHERE entity_type = $1 AND slug = $2 AND project_id IS NOT DISTINCT FROM $3',
        ['ticket', d.slug, projectId]
      );
      if (ex.rows[0]) {
        console.log(`  skip  ${d.slug} (exists, id ${ex.rows[0].id}${ex.rows[0].computed ? '' : ', NOT computed — check it'})`);
        defIds.push(ex.rows[0].id);
        continue;
      }
      const r = await client.query(
        `INSERT INTO custom_field_defs
           (entity_type, slug, label, type, options, required, sort_order, help_text, project_id, sensitive, agent_only, computed, formula)
         VALUES ('ticket', $1, $2, 'text', '[]'::jsonb, FALSE, 0, $3, $4, $5, TRUE, TRUE, $6)
         RETURNING id`,
        [d.slug, d.label, d.help_text, projectId, d.sensitive, d.formula]
      );
      console.log(`  create ${d.slug} -> id ${r.rows[0].id}${d.sensitive ? ' (sensitive)' : ''}`);
      defIds.push(r.rows[0].id);
    }

    // Auto-bind only when unambiguous: a single form in the project.
    const forms = await client.query(
      `SELECT f.id, f.name FROM ticket_forms f
         JOIN ticket_categories c ON c.id = f.category_id
        WHERE c.project_id = $1`,
      [projectId]
    );
    if (forms.rows.length === 1) {
      const formId = forms.rows[0].id;
      let order = await client.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM ticket_form_fields WHERE form_id = $1', [formId]);
      let n = order.rows[0].n;
      for (const defId of defIds) {
        await client.query(
          `INSERT INTO ticket_form_fields (form_id, field_def_id, required, sort_order)
           VALUES ($1, $2, FALSE, $3)
           ON CONFLICT (form_id, field_def_id) DO NOTHING`,
          [formId, defId, n++]
        );
      }
      console.log(`Bound 4 fields to the only form: "${forms.rows[0].name}" (id ${formId}).`);
    } else {
      console.log(`Project has ${forms.rows.length} forms — NOT auto-binding. Tick these fields onto the HR form in Admin → Forms.`);
    }

    console.log('Done.');
  } catch (e) {
    console.error('seed failed:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
