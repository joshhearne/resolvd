// Ollama adapter (local self-hosted). Default endpoint is the loopback
// instance; user configures their own LAN address. No api key by default
// (Ollama is unauthenticated by default, but a reverse-proxy could front
// it with bearer auth — apiKey is optional).

const fetch = require('node-fetch');
const { fromResponse, fromFetchError } = require('./errors');

const PROVIDER = 'Ollama';

async function complete({ endpoint, apiKey, model, system, user, signal, timeoutMs = 60000 }) {
  const url = (endpoint || 'http://localhost:11434').replace(/\/$/, '') + '/api/chat';
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
          stream: false,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          options: { temperature: 0.6 },
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
    const text = json?.message?.content || '';
    const usage = (json?.prompt_eval_count != null || json?.eval_count != null)
      ? { input_tokens: json.prompt_eval_count, output_tokens: json.eval_count }
      : null;
    return { text, usage };
  } finally {
    clearTimeout(timer);
  }
}

// Curated suggestions only — what Ollama can actually run depends on
// what the user has pulled locally. The dropdown UI prefers the live
// list (via listLiveModels) when reachable; this static list serves as
// fallback hints when the Ollama server is unreachable.
const recommendedModels = [
  { id: 'llama3.1',  label: 'Llama 3.1 (8B)',     tier: 'cheap',    recommended: true, note: 'Common default. `ollama pull llama3.1` first.' },
  { id: 'llama3.3',  label: 'Llama 3.3 (70B)',    tier: 'heavy',    note: 'Heaviest open weight from Meta. Needs a GPU.' },
  { id: 'qwen2.5',   label: 'Qwen 2.5',           tier: 'balanced', note: 'Strong on instruction-following.' },
  { id: 'mistral',   label: 'Mistral 7B',         tier: 'cheap' },
  { id: 'phi4',      label: 'Phi-4 (14B)',        tier: 'balanced', note: 'Microsoft\'s small-model series.' },
];

// Hit the local Ollama instance for its model list. Returns whatever
// the user has pulled.
async function listLiveModels({ endpoint, apiKey }) {
  const url = (endpoint || 'http://localhost:11434').replace(/\/$/, '') + '/api/tags';
  let r;
  try {
    r = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
  } catch (err) {
    throw fromFetchError({ provider: PROVIDER, err });
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw fromResponse({ provider: PROVIDER, status: r.status, body });
  }
  const json = await r.json();
  return (json?.models || [])
    .map(m => ({
      id: m.name || m.model,
      label: m.name || m.model,
      tier: 'live',
      // Surface size in note so users see what they have at a glance.
      note: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = {
  id: 'ollama',
  label: 'Ollama (self-hosted)',
  defaultEndpoint: 'http://localhost:11434',
  defaultModel: 'llama3.1',
  needsApiKey: false,
  consoleUrl: 'https://ollama.com/library',
  consoleLabel: 'Ollama library',
  setupHint: 'Self-hosted — install Ollama on your network, pull a model with `ollama pull llama3.1`, point Endpoint URL at the host. No key needed by default; add bearer auth via reverse proxy if exposing externally.',
  complete,
  recommendedModels,
  listLiveModels,
};
