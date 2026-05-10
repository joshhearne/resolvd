// Provider registry for the BYO-AI text rewrite feature.
//
// Each adapter exports { id, label, defaultEndpoint, defaultModel, complete }.
// `complete({ endpoint, apiKey, model, system, user, signal })` returns
// { text, usage } where usage is { input_tokens, output_tokens } if known.
//
// New adapters drop in by adding a file + registering below.

const openai = require('./openai');
const anthropic = require('./anthropic');
const ollama = require('./ollama');

const ADAPTERS = {
  [openai.id]: openai,
  [anthropic.id]: anthropic,
  [ollama.id]: ollama,
};

function listProviders() {
  return Object.values(ADAPTERS).map(a => ({
    id: a.id,
    label: a.label,
    default_endpoint: a.defaultEndpoint,
    default_model: a.defaultModel,
    needs_api_key: a.needsApiKey !== false,
  }));
}

function getAdapter(providerId) {
  const a = ADAPTERS[providerId];
  if (!a) throw new Error(`Unknown AI provider: ${providerId}`);
  return a;
}

module.exports = { listProviders, getAdapter };
