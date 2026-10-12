// Minimal iCalendar (RFC 5545) writer for subscribable feeds. Only what
// read-only calendars need: VCALENDAR + VEVENT with UTC times, text
// escaping and 75-octet line folding.

const CRLF = '\r\n';

function escapeText(v) {
  return String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// 20261012T210808Z
function utcStamp(d) {
  return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Fold a content line at 75 octets without splitting a UTF-8 sequence.
function fold(line) {
  const buf = Buffer.from(line, 'utf8');
  if (buf.length <= 75) return line;
  const parts = [];
  let start = 0;
  let limit = 75;
  while (start < buf.length) {
    let end = Math.min(start + limit, buf.length);
    // Back off continuation bytes (10xxxxxx) so a character stays whole.
    while (end < buf.length && (buf[end] & 0xc0) === 0x80) end -= 1;
    parts.push(buf.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuation lines start with a space
  }
  return parts.join(`${CRLF} `);
}

// events: [{ uid, start, end, summary, description?, location?, url?,
//            categories?: [], updated?, sequence?, status? }]
function buildCalendar({ name, description, events, now = new Date() }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Resolvd//Scheduled Work//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT30M',
    'X-PUBLISHED-TTL:PT30M',
  ];
  if (description) lines.push(`X-WR-CALDESC:${escapeText(description)}`);
  const stamp = utcStamp(now);
  for (const ev of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${ev.uid}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART:${utcStamp(ev.start)}`);
    lines.push(`DTEND:${utcStamp(ev.end)}`);
    lines.push(`SUMMARY:${escapeText(ev.summary)}`);
    if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
    if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
    if (ev.url) lines.push(`URL:${ev.url}`);
    if (ev.categories?.length) lines.push(`CATEGORIES:${ev.categories.map(escapeText).join(',')}`);
    if (ev.updated) lines.push(`LAST-MODIFIED:${utcStamp(ev.updated)}`);
    if (Number.isInteger(ev.sequence)) lines.push(`SEQUENCE:${ev.sequence}`);
    lines.push(`STATUS:${ev.status || 'CONFIRMED'}`);
    lines.push('TRANSP:OPAQUE');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join(CRLF) + CRLF;
}

module.exports = { buildCalendar, escapeText, utcStamp, fold };
