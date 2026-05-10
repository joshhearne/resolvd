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

module.exports = {
  id: 'openai',
  label: 'OpenAI / OpenAI-compatible',
  defaultEndpoint: 'https://api.openai.com',
  defaultModel: 'gpt-4o-mini',
  complete,
};
