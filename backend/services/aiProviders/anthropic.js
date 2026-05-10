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

module.exports = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  defaultEndpoint: 'https://api.anthropic.com',
  defaultModel: 'claude-haiku-4-5-20251001',
  complete,
};
