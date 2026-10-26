// Holiday matching for business-hours policies. Pure — shared by the SLA
// clock (businessHours.js) and billing's hours classes (billingRules.js).
//
// A holiday is { date: 'YYYY-MM-DD', recurring }. recurring matches the
// month/day every year. Callers pass local calendar parts in the policy's
// tz, so a holiday is a whole local day.

function holidayMatcher(holidays) {
  const fixed = new Set();
  const yearly = new Set();
  for (const h of holidays || []) {
    const d = String(h?.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (h.recurring) yearly.add(d.slice(5)); else fixed.add(d);
  }
  if (!fixed.size && !yearly.size) return () => false;
  const pad = (n) => String(n).padStart(2, '0');
  return (year, month, day) => {
    const md = `${pad(month)}-${pad(day)}`;
    return yearly.has(md) || fixed.has(`${year}-${md}`);
  };
}

module.exports = { holidayMatcher };
