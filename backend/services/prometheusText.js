// Minimal parser for the Prometheus text exposition format. Enough for
// gauge/counter lines like:
//   monitor_status{monitor_id="7",monitor_name="Site \"A\""} 1
// Comments (# HELP / # TYPE) and blank lines are skipped. Returns
// [{ name, labels: {k: v}, value: Number }].

function parseLabels(src) {
  const labels = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"\s*,?\s*/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    labels[m[1]] = m[2].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));
  }
  return labels;
}

function parsePrometheusText(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const brace = line.indexOf('{');
    let name;
    let labels = {};
    let rest;
    if (brace !== -1) {
      name = line.slice(0, brace);
      const close = line.lastIndexOf('}');
      if (close < brace) continue;
      labels = parseLabels(line.slice(brace + 1, close));
      rest = line.slice(close + 1).trim();
    } else {
      const sp = line.indexOf(' ');
      if (sp === -1) continue;
      name = line.slice(0, sp);
      rest = line.slice(sp + 1).trim();
    }
    const value = Number(rest.split(/\s+/)[0]);
    if (!name || Number.isNaN(value)) continue;
    out.push({ name, labels, value });
  }
  return out;
}

module.exports = { parsePrometheusText };
