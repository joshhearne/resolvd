#!/usr/bin/env node
// Export Resolvd kb_articles (BlockNote JSON) to Markdown files with YAML
// frontmatter in the layout Bothy's importer reads, split into two archives:
//   internal/  agent_only articles and drafts   -> Bothy collection "MOT IT Internal"
//   public/    everything else                  -> Bothy collection "MOT IT Public"
// Runbooks: each top-level list item ends with {#<first 8 hex of BlockNote block id>}
// so per-ticket progress (ticket_runbook_runs.step_states keyed by block id) can be
// re-keyed later; the mapping is written to runbook-step-map.json.
//
// Usage: node export-kb-to-bothy.js <articles.json> <out-dir>
//   articles.json = json_agg of kb_articles joined to projects (see docs/BOTHY_INTEGRATION.md)
'use strict';
const fs = require('fs');
const path = require('path');

const [,, src, out] = process.argv;
if (!src || !out) { console.error('usage: export-kb-to-bothy.js <articles.json> <out-dir>'); process.exit(1); }
const articles = JSON.parse(fs.readFileSync(src, 'utf8'));

function inline(nodes) {
  if (!Array.isArray(nodes)) return '';
  return nodes.map((n) => {
    if (n.type === 'link') return `[${inline(n.content)}](${n.href})`;
    if (n.type !== 'text') return '';
    let t = n.text || '';
    const s = n.styles || {};
    if (s.code) t = '`' + t + '`';
    if (s.bold) t = `**${t}**`;
    if (s.italic) t = `*${t}*`;
    if (s.strike) t = `~~${t}~~`;
    return t;
  }).join('');
}

function indent(text, n) {
  const pad = ' '.repeat(n);
  return text.split('\n').map((l) => (l.trim() ? pad + l : l)).join('\n');
}

function table(block) {
  const rows = block.content?.rows || [];
  if (!rows.length) return '';
  const cells = rows.map((r) => r.cells.map((c) => inline(c.content).replace(/\|/g, '\\|')));
  const width = Math.max(...cells.map((r) => r.length));
  const line = (r) => '| ' + Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ') + ' |';
  return [line(cells[0]), '|' + ' --- |'.repeat(width), ...cells.slice(1).map(line)].join('\n');
}

// Renders a block list. ctx.steps collects {blockId, stepId} for top-level list items
// when ctx.runbook is set and depth === 0.
function render(blocks, depth, ctx) {
  const out = [];
  let num = 0;
  for (const b of blocks || []) {
    const kids = b.children?.length ? render(b.children, depth + 1, ctx) : '';
    switch (b.type) {
      case 'heading': {
        num = 0;
        out.push(`${'#'.repeat(Math.min(6, (b.props?.level || 1) + 1))} ${inline(b.content)}`);
        break;
      }
      case 'paragraph': {
        num = 0;
        const t = inline(b.content);
        if (t.trim()) out.push(t);
        break;
      }
      case 'codeBlock': {
        num = 0;
        const lang = b.props?.language && b.props.language !== 'text' ? b.props.language : '';
        out.push('```' + lang + '\n' + (b.content || []).map((c) => c.text || '').join('') + '\n```');
        break;
      }
      case 'table': { num = 0; out.push(table(b)); break; }
      case 'numberedListItem':
      case 'bulletListItem':
      case 'checkListItem': {
        num += 1;
        let text = inline(b.content);
        let marker;
        if (b.type === 'numberedListItem') marker = `${num}.`;
        else if (b.type === 'checkListItem') marker = b.props?.checked ? '- [x]' : '- [ ]';
        else marker = '-';
        if (ctx.runbook && depth === 0) {
          const stepId = String(b.id || '').replace(/-/g, '').slice(0, 8).toLowerCase() || `s${num}`;
          ctx.steps.push({ block_id: b.id, step_id: stepId, text });
          text = `${text} {#${stepId}}`;
        }
        // Merge adjacent list items into one list: join with single newlines.
        const item = `${marker} ${text}` + (kids ? '\n' + indent(kids, marker.length + 1) : '');
        const prev = out[out.length - 1];
        if (prev && /^(\d+\.|-|- \[[ x]\]) /.test(prev)) out[out.length - 1] = prev + '\n' + item;
        else out.push(item);
        break;
      }
      default: {
        num = 0;
        const t = inline(b.content);
        if (t.trim()) out.push(t);
      }
    }
  }
  return out.join('\n\n');
}

function yamlStr(s) { return JSON.stringify(String(s)); }
function slugDir(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

const manifest = { internal: [], public: [] };
const stepMap = {};
let n = 0;
for (const a of articles) {
  const ctx = { runbook: a.kind === 'runbook', steps: [] };
  const body = render(a.content_json, 0, ctx);
  const bucket = (a.agent_only || a.status !== 'published') ? 'internal' : 'public';
  const rel = path.join(slugDir(a.project), `${a.slug}.md`);
  const file = path.join(out, bucket, rel);
  const fm = [
    '---',
    `title: ${yamlStr(a.title)}`,
    `external_id: ${yamlStr(`resolvd:kb:${a.id}`)}`,
    `category: ${yamlStr(a.project)}`,
    `kind: ${a.kind}`,
    a.status !== 'published' ? `draft: true` : null,
    a.agent_only ? `internal_only: true` : null,
    a.tags?.length ? `tags: [${a.tags.map(yamlStr).join(', ')}]` : null,
    a.keywords?.length ? `keywords: [${a.keywords.map(yamlStr).join(', ')}]` : null,
    a.author ? `author: ${yamlStr(a.author)}` : null,
    `date_created: ${new Date(a.created_at).toISOString()}`,
    `date_modified: ${new Date(a.updated_at).toISOString()}`,
    `source: ${yamlStr(`resolvd/${a.project}/${a.slug}`)}`,
    '---',
  ].filter(Boolean).join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${fm}\n\n# ${a.title}\n\n${body}\n`);
  manifest[bucket].push({ external_id: `resolvd:kb:${a.id}`, path: rel, date_modified: new Date(a.updated_at).toISOString() });
  if (ctx.runbook) stepMap[a.id] = { slug: a.slug, steps: ctx.steps };
  n += 1;
}
for (const bucket of ['internal', 'public']) {
  fs.mkdirSync(path.join(out, bucket), { recursive: true });
  fs.writeFileSync(path.join(out, bucket, 'manifest.json'), JSON.stringify({ articles: manifest[bucket] }, null, 2));
}
fs.writeFileSync(path.join(out, 'runbook-step-map.json'), JSON.stringify(stepMap, null, 2));
console.log(`wrote ${n} articles: internal=${manifest.internal.length} public=${manifest.public.length}; runbooks=${Object.keys(stepMap).length}`);
