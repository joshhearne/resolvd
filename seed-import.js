// One-time seed script — run inside the backend container:
// docker exec mot-issues-backend node /app/seed-import.js

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const STATUS_MAP = {
  'complete - awaiting review': 'Resolved',
  'live page': 'Resolved',
  'complete': 'Resolved',
  'resolved': 'Resolved',
  'in progress': 'In Progress',
  'in-progress': 'In Progress',
  'feedback needed': 'In Progress',
  'missing details': 'In Progress',
  'ready to work': 'Acknowledged',
  'todo': 'Acknowledged',
  'new': 'Unacknowledged',
  'onboarding / inv prep': 'In Progress',
  'post launch': 'In Progress',
  'graveyard': "Won't Fix",
};

const TITLE_PREFIXES = ['Motorhomes of Texas - ', 'Texas Motorhomes - '];
function cleanTitle(t) {
  for (const p of TITLE_PREFIXES) { if (t.startsWith(p)) return t.slice(p.length); }
  return t;
}

function computePriority(i, u) { return Math.min(Math.max(i + u - 1, 1), 5); }

async function nextMotRef(client, projectId) {
  const result = await client.query(
    'UPDATE projects SET ticket_counter = ticket_counter + 1 WHERE id = $1 RETURNING ticket_counter, prefix',
    [projectId]
  );
  const { ticket_counter, prefix } = result.rows[0];
  return `${prefix}-${String(ticket_counter).padStart(4, '0')}`;
}

// Raw data: [status, task_id, title]
const RAW = [
  ['complete - awaiting review','86e1257q5','Motorhomes of Texas - 1,300 Historical Units from Dealerspike: AI Match Training + Raw Data Export'],
  ['complete - awaiting review','86e10kfex','Motorhomes of Texas - 1300 Units Data Clarification'],
  ['complete - awaiting review','86e12577q','Motorhomes of Texas - Add Generator Hours Spec Field to Inventory'],
  ['complete - awaiting review','86e1257dm','Motorhomes of Texas - Add Odometer Accuracy Field to Inventory Specs'],
  ['complete - awaiting review','86e1256pu','Motorhomes of Texas - Breadcrumbs Showing Duplicate Unit Names & "UNKNOWN" Entries'],
  ['complete - awaiting review','86e10kf1w','Motorhomes of Texas - Consignment Coaches Not on New Site (C3475, C3447)'],
  ['complete - awaiting review','86e0x07up','Motorhomes of Texas - Contact Us Form Leads Change'],
  ['complete - awaiting review','86e10kfda','Motorhomes of Texas - DNS Records Update for DKIM'],
  ['complete - awaiting review','86e1256rj','Motorhomes of Texas - Homepage Video Controls Briefly Visible on Load'],
  ['complete - awaiting review','86e1257u2','Motorhomes of Texas - IDS G2 to Stealth Integration Field Mapping Documentation Needed'],
  ['complete - awaiting review','86e1257fy','Motorhomes of Texas - Increase Inventory Refresh Rate to Every 15 Minutes'],
  ['complete - awaiting review','86e10kf8u','Motorhomes of Texas - Internal Hang Tag Brochures + UTM QR Codes'],
  ['complete - awaiting review','86e11wjdr','Motorhomes of Texas - Inventory Data Mapping Issues - Vehicle Type, Fuel Type, DMS Website Flag Logic'],
  ['complete - awaiting review','86e1029hd','Motorhomes of Texas - MEDIA FILTERING ON VDPs'],
  ['complete - awaiting review','86e1256mn','Motorhomes of Texas - Mobile Navbar Items Hidden on Non-Maximized Screens'],
  ['complete - awaiting review','86e102dnr','Motorhomes of Texas - STEALTH INVENTORY FIELD CLARIFICATION'],
  ['complete - awaiting review','86e10kfb0','Motorhomes of Texas - Stealth Inventory Access: Mike Martinkus + Matt Watson'],
  ['complete - awaiting review','86e1257jx','Motorhomes of Texas - VDP Media Gallery Filter Tabs / Carousel POC - Status Update Needed'],
  ['complete - awaiting review','86e10kf66','Motorhomes of Texas - YouTube Videos Not Displaying on VDPs'],
  ['live page','86e0z1n8z','Motorhomes of Texas - Add Careers Link to About Navigation Menu'],
  ['live page','86e0x8y2b','Motorhomes of Texas - Bottom Red Text Stroke Updates + Styling Consistency (4 Pages)'],
  ['live page','86e0z555g','Motorhomes of Texas - Fix 404 Error (Google Search Link)'],
  ['live page','86e0yzdgf','Motorhomes of Texas - Homepage Inventory Carousel Default to Highest Priced Units First'],
  ['live page','86e103jf6','Motorhomes of Texas - Homepage Paragraph Font Size (Step Up 1 Size)'],
  ['live page','86e0x8xxa','Motorhomes of Texas - Index Banner White Stroke Alpha Update'],
  ['live page','86e0yzd9h','Motorhomes of Texas - Inventory Data: Historical Descriptions & Equipment Not Showing'],
  ['live page','86e0w8zna','Motorhomes of Texas - Inventory Photo Order Should Match Current Website'],
  ['live page','86e10p4dx','Motorhomes of Texas - Lower Homepage Hero Video Overlay Opacity'],
  ['live page','86e0wejz0','Motorhomes of Texas - Multi-Page Content & Design Updates'],
  ['live page','86e0x8y0v','Motorhomes of Texas - Navbar Font Size Increase (11px -> 14px)'],
  ['live page','86e10p401','Motorhomes of Texas - Reduce "#1 Luxury Consignment" Text Stroke & Alpha (Mobile + Desktop)'],
  ['live page','86e10nxgu','Motorhomes of Texas - Sitewide Text Color + Navbar Contrast Updates (3 items)'],
  ['live page','86e103jgb','Motorhomes of Texas - Top-Level Nav Font Size 14px + High-Contrast White'],
  ['live page','86e0xvra1','Motorhomes of Texas - Update Form ID'],
  ['live page','86e0yzdku','Motorhomes of Texas - VIN Numbers Not Displaying on VDP'],
  ['live page','86e10p48r','Motorhomes of Texas - [PRIORITY] Mobile Navbar Unit Search Bar Unreachable (iOS + Android)'],
  ['resolved','86e037gk1','Motorhomes of Texas Stealth Reporting Missing'],
  ['resolved','86e0rwmyc','Adjust footer heading size and weight to match mockup (sub)'],
  ['resolved','86e0rwmx8','Adjust padding inside FAQ rows to match mockup (sub)'],
  ['resolved','86e0rwmwc','Adjust section height to match mockup (sub)'],
  ['resolved','86e0rwmx1','Adjust spacing between FAQ items to match mockup (sub)'],
  ['resolved','86e119mb2','Motorhomes of Texas - Stealth Inventory 505 error'],
  ['resolved','86e103dr7','Motorhomes of Texas - Unit Pulling Floor Plan Image Instead of Stock Photo'],
  ['resolved','86e0x1ym4','Motorhomes of Texas Post Website Launch High Priority Change'],
  ['resolved','86e0rwkvd','Update dev site to match mockups (sub)'],
  ['resolved','86e0rwmyk','Update footer alignment to match mockup (sub)'],
  ['resolved','86e0rwmr9','Update hero layout to match mockup (sub)'],
  ['resolved','86e0rwmry','Update hero text positioning to match mockup (sub)'],
  ['resolved','86e0rwmxy','Update layout to match mockup (sub)'],
  ['resolved','86e0rwmu5','Update layout to match mockup (sub)'],
  ['resolved','86e0rwkvj','Verify website matches client mockups (sub)'],
  ['in progress','86e0yzdpj','Motorhomes of Texas - Add AppOne Integration on VDPs'],
  ['in progress','86e0u5q1p','Motorhomes of Texas - Add Marchex Call Tracking Script'],
  ['in-progress','86e12g0rw','Motorhomes of Texas - Default Spec Field Pre-Population'],
  ['in-progress','86e10njpc','Motorhomes of Texas - NEW DEV REQUEST - UI/UX UPDATES POST-LAUNCH'],
  ['in-progress','86e0w9ww','Motorhomes of Texas - Post Launch Staff Page Updates'],
  ['feedback needed','86e0wn3a9','DNS Errors 522/403 - New Site Go Live'],
  ['feedback needed','86e10kf3e','Motorhomes of Texas - Photo Upload 500 Errors / Dealer Spike Image Sizing'],
  ['feedback needed','86e1257j1','Motorhomes of Texas - Privacy Page 404 Error Compliance Issue'],
  ['feedback needed','86e12574a','Motorhomes of Texas - Sold/Cancelled Units Still Displaying "Coming Soon" Banner'],
  ['feedback needed','86e1256jg','Motorhomes of Texas - Unit Pricing Displaying DMS "TAKE" Price Instead of "WEB" Price (Unit C3338)'],
  ['feedback needed','86e1256g8','Texas Motorhomes - ESCALATED: DMS Mileage Sync (IDS -> Stealth) Not Coming Through'],
  ['graveyard','86e103ji0','Motorhomes of Texas - "#1 Luxury Consignment Dealer" White Border Width Increase'],
  ['graveyard','86e0yzdth','Motorhomes of Texas - Missing Equipment/ Data Units'],
  ['graveyard','86e0y8ere','Motorhomes of Texas - Post Launch Staff Page Updates'],
  ['graveyard','86e0y8epf','Motorhomes of Texas - Post Website Launch High Priority Changes'],
  ['graveyard','86e0yzdwj','Motorhomes of Texas - Tank Capacity Showing "1 Tank" Instead of Gallon Capacity'],
  ['missing details','86e0wa494','Motorhomes of Texas - Add Staff Page to Website'],
  ['missing details','86e0xg24y','Motorhomes of Texas - IDS Pending Status Not Syncing to Stealth'],
  ['missing details','86e0yzde9','Motorhomes of Texas - Inventory Filtering: Sold & Inactive Units Showing Incorrectly'],
  ['missing details','86e0x8y89','Motorhomes of Texas - Privacy Policy Page Needed (Awaiting Copy from Client)'],
  ['new','86e1051pk','Documented Website Changes'],
  ['onboarding / inv prep','86dyefz5e','Texas Motorhomes (Website Launch)'],
  ['post launch','86dyuxxcq','Motorhomes of Texas'],
  ['ready to work','86dyuxxd7','Inventory Setup (subtask of Motorhomes of Texas Launch)'],
  ['todo','86e12575w','Motorhomes of Texas - "Get Financing" Routing to Payment Calculator Instead of AppOne'],
];

async function run() {
  const client = await pool.connect();
  let created = 0, skipped = 0;

  try {
    await client.query('BEGIN');

    // Seed the WEB project
    const projResult = await client.query(`
      INSERT INTO projects (name, prefix, description, status)
      VALUES ('Motorhomes of Texas Website', 'WEB', 'Website issues tracked with Coastal Technologies', 'active')
      ON CONFLICT (prefix) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `);
    const webProjectId = projResult.rows[0].id;
    console.log(`WEB project id: ${webProjectId}`);

    for (const [rawStatus, taskId, rawTitle] of RAW) {
      const existing = await client.query('SELECT id FROM tickets WHERE coastal_ticket_ref = $1', [taskId]);
      if (existing.rows[0]) { skipped++; continue; }

      const coastalStatus = STATUS_MAP[rawStatus.toLowerCase()] || 'Unacknowledged';
      const isResolved = coastalStatus === 'Resolved';
      const internalStatus = isResolved ? 'Pending Review' : 'Open';
      const flagged = isResolved;
      const priority = computePriority(2, 2);
      const motRef = await nextMotRef(client, webProjectId);
      const title = cleanTitle(rawTitle);

      const result = await client.query(`
        INSERT INTO tickets
          (project_id, mot_ref, title, coastal_ticket_ref, coastal_status, internal_status,
           impact, urgency, computed_priority, effective_priority, flagged_for_review, submitted_by)
        VALUES ($1, $2, $3, $4, $5, $6, 2, 2, $7, $7, $8, NULL)
        RETURNING id
      `, [webProjectId, motRef, title, taskId, coastalStatus, internalStatus, priority, flagged]);

      await client.query(`
        INSERT INTO audit_log (ticket_id, user_id, action, note)
        VALUES ($1, NULL, 'ticket_created', 'Seeded from ClickUp export')
      `, [result.rows[0].id]);

      created++;
    }

    await client.query('COMMIT');
    console.log(`Done. Created: ${created}, Skipped (already exist): ${skipped}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
