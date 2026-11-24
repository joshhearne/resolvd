// Where a ticket came from. Stored on tickets.source; the system sets it
// for channels it handles itself (email ingest, alerts, schedules) and
// an agent picks it when logging one by hand (a phone call, an SMS, a
// Teams chat). Admins see it on the ticket and can filter by it.
//
// `manual: true` sources are offered in the New Ticket picker to agents.
// Submitters always file as 'web'.

const TICKET_SOURCES = [
  { key: 'web',             label: 'Web / portal',               manual: true },
  { key: 'email',           label: 'Email',                      manual: true },
  { key: 'email_forwarded', label: 'Email (forwarded by agent)', manual: false },
  { key: 'phone',           label: 'Phone call',                 manual: true },
  { key: 'sms',             label: 'SMS',                        manual: true },
  { key: 'teams',           label: 'Teams chat',                 manual: true },
  { key: 'scheduled',       label: 'Scheduled ticket',           manual: false },
  { key: 'api',             label: 'API',                        manual: false },
  { key: 'alert',           label: 'Monitoring alert',           manual: false },
];

const SOURCE_KEYS = TICKET_SOURCES.map((s) => s.key);
const MANUAL_SOURCE_KEYS = TICKET_SOURCES.filter((s) => s.manual).map((s) => s.key);

const isSource = (v) => SOURCE_KEYS.includes(v);

module.exports = { TICKET_SOURCES, SOURCE_KEYS, MANUAL_SOURCE_KEYS, isSource };
