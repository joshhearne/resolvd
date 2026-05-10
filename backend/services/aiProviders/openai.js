// OpenAI Chat Completions adapter. Compatible with any provider that
// speaks /v1/chat/completions (Azure OpenAI, OpenRouter, vLLM, LM Studio).
// User configures endpoint URL + model in their AI Assist prefs.

const fetch = require('node-fetch');
const { fromResponse, fromFetchError } = require('./errors');

const PROVIDER = 'OpenAI';

async function complete({ endpoint, apiKey, model, system, user, signal, timeoutMs = 30000 }) {
  const url = (endpoint || 'https://api.openai.com').replace(/\/$/, '') + '/v1/chat/completions';
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
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.6,
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
    const text = json?.choices?.[0]?.message?.content || '';
    const usage = json?.usage
      ? { input_tokens: json.usage.prompt_tokens, output_tokens: json.usage.completion_tokens }
      : null;
    return { text, usage };
  } finally {
    clearTimeout(timer);
  }
}

// Curated list of OpenAI chat-completion models worth surfacing in the
// dropdown. Bundled so the picker works even before the user pastes an
// API key. Update this list when OpenAI ships a new generation.
//
// `tier` is one of: cheap | balanced | heavy. The frontend groups by
// tier so users have a clear cost/quality tradeoff.
const recommendedModels = [
  { id: 'gpt-4o-mini',   label: 'GPT-4o mini',   tier: 'cheap',    note: 'Cheapest. Fine for short rewrites; weaker on instruction-following.' },
  { id: 'gpt-4.1-mini',  label: 'GPT-4.1 mini',  tier: 'cheap',    note: 'Newer cheap tier — better at following the "no preamble" rule than 4o-mini.' },
  { id: 'gpt-4.1',       label: 'GPT-4.1',       tier: 'balanced', recommended: true, note: 'Recommended default. Closest match to Claude Sonnet quality.' },
  { id: 'gpt-4o',        label: 'GPT-4o',        tier: 'balanced' },
  { id: 'o4-mini',       label: 'o4-mini',       tier: 'heavy',    note: 'Reasoning model. Slower + pricier; overkill for routine rewrites.' },
];

// Live fetch from /v1/models. Returns adapter-shaped entries (id only —
// OpenAI's models endpoint doesn't carry friendly labels). Caller can
// merge with recommendedModels for the union view.
async function listLiveModels({ endpoint, apiKey }) {
  const url = (endpoint || 'https://api.openai.com').replace(/\/$/, '') + '/v1/models';
  let r;
  try {
    r = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey || ''}` },
    });
  } catch (err) {
    throw fromFetchError({ provider: PROVIDER, err });
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw fromResponse({ provider: PROVIDER, status: r.status, body });
  }
  const json = await r.json();
  // Filter to chat-completion-capable models. OpenAI returns image, audio,
  // embeddings models too — exclude those.
  return (json?.data || [])
    .map(m => m.id)
    .filter(id =>
      /^(gpt|o[1-9])/.test(id) &&
      !/(transcribe|tts|whisper|embedding|moderation|dall|image|audio)/i.test(id)
    )
    .sort()
    .map(id => ({ id, label: id, tier: 'live' }));
}

module.exports = {
  id: 'openai',
  label: 'OpenAI / OpenAI-compatible',
  defaultEndpoint: 'https://api.openai.com',
  defaultModel: 'gpt-4.1',
  complete,
  recommendedModels,
  listLiveModels,
};
