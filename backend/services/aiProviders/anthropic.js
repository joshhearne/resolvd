// Anthropic Messages adapter (claude-* models). Different envelope than
// OpenAI: system goes in a top-level field, messages array carries only
// user/assistant turns, and api key uses x-api-key + anthropic-version.

const fetch = require('node-fetch');
const { fromResponse, fromFetchError } = require('./errors');

const API_VERSION = '2023-06-01';
const PROVIDER = 'Anthropic';

async function complete({ endpoint, apiKey, model, system, user, signal, timeoutMs = 30000 }) {
  const url = (endpoint || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
  const ctrl = new AbortController();
  const sig = signal || ctrl.signal;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey || '',
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal: sig,
      });
    } catch (err) {
      throw fromFetchError({ provider: PROVIDER, err });
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw fromResponse({ provider: PROVIDER, status: r.status, body });
    }
    const json = await r.json();
    // Messages API content is an array of blocks; pull the text blocks.
    const text = (json?.content || [])
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('');
    const usage = json?.usage
      ? { input_tokens: json.usage.input_tokens, output_tokens: json.usage.output_tokens }
      : null;
    return { text, usage };
  } finally {
    clearTimeout(timer);
  }
}

// Curated list of Anthropic Claude models. Anthropic uses dated model
// IDs — the latest dated build is what `claude-X-Y` aliases roll up to,
// but the explicit dated form is what the API expects. Refresh this list
// when Anthropic ships a new generation.
const recommendedModels = [
  { id: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5',  tier: 'cheap',    recommended: true, note: 'Recommended default. Fast, cheap, surprisingly strong on rewrite tasks.' },
  { id: 'claude-sonnet-4-6',          label: 'Claude Sonnet 4.6', tier: 'balanced', note: 'Bigger model — better nuance on tone shifts. Recommended for ELI5 / verbose output.' },
  { id: 'claude-opus-4-7',            label: 'Claude Opus 4.7',   tier: 'heavy',    note: 'Heaviest tier. Overkill for short rewrites; useful for long-form polish.' },
];

// Live fetch from /v1/models. Anthropic added this endpoint in 2024 — it
// returns models the caller's API key can access.
async function listLiveModels({ endpoint, apiKey }) {
  const url = (endpoint || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/models';
  let r;
  try {
    r = await fetch(url, {
      headers: {
        'x-api-key': apiKey || '',
        'anthropic-version': API_VERSION,
      },
    });
  } catch (err) {
    throw fromFetchError({ provider: PROVIDER, err });
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw fromResponse({ provider: PROVIDER, status: r.status, body });
  }
  const json = await r.json();
  return (json?.data || [])
    .map(m => ({ id: m.id, label: m.display_name || m.id, tier: 'live' }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  defaultEndpoint: 'https://api.anthropic.com',
  defaultModel: 'claude-haiku-4-5-20251001',
  consoleUrl: 'https://console.anthropic.com/settings/keys',
  consoleLabel: 'Anthropic console',
  setupHint: 'Create a key on the Anthropic console. Add credits first ($5 minimum, covers a lot of Haiku rewrites). Paste the sk-ant-... key here.',
  complete,
  recommendedModels,
  listLiveModels,
};
