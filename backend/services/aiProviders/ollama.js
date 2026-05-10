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

module.exports = {
  id: 'ollama',
  label: 'Ollama (self-hosted)',
  defaultEndpoint: 'http://localhost:11434',
  defaultModel: 'llama3.1',
  needsApiKey: false,
  complete,
};
