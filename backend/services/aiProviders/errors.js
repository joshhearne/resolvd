// Cross-provider error model. Each adapter wraps non-ok responses in a
// ProviderError so callers (route handler + UI) get a consistent { kind,
// friendly, providerMessage } shape regardless of which provider was hit.
//
// kind is one of:
//   auth            — API key rejected (401, or 400 w/ "invalid api key")
//   billing         — out of credits / quota / balance
//   rate_limit      — too many requests
//   model_not_found — model id not recognized by provider
//   bad_request     — other 4xx (malformed input, content-policy violation, …)
//   server_error    — provider 5xx
//   network         — couldn't reach provider (timeout / DNS / TLS)
//   unknown         — anything else
//
// `friendly` is a short user-facing sentence the UI can render directly.
// `providerMessage` carries the upstream message (truncated) so debugging
// is possible without scraping logs.

class ProviderError extends Error {
  constructor({ kind, friendly, providerMessage = '', provider, status = 0 }) {
    super(friendly);
    this.name = 'ProviderError';
    this.kind = kind;
    this.friendly = friendly;
    this.providerMessage = providerMessage;
    this.provider = provider;
    this.status = status;
    // 502 = upstream provider rejected. Routes use this to set HTTP status.
    this.httpStatus = 502;
  }
}

// Map an HTTP response (plus its body text) into a ProviderError. Each
// provider's body shape is slightly different — keyword-match against the
// substring lowercased.
function fromResponse({ provider, status, body }) {
  const text = String(body || '').toLowerCase();
  const trimmed = String(body || '').slice(0, 400);

  // Billing — checked before auth/rate_limit because providers sometimes
  // return 400 with billing message instead of 402.
  if (
    text.includes('credit balance') ||
    text.includes('insufficient_quota') ||
    text.includes('quota') && text.includes('exceed') ||
    text.includes('billing') ||
    status === 402
  ) {
    return new ProviderError({
      kind: 'billing',
      friendly: `${provider} reports your account is out of credits or billing isn't configured. Top up + retry.`,
      providerMessage: trimmed,
      provider,
      status,
    });
  }
  if (status === 401 || status === 403 || text.includes('invalid api key') || text.includes('authentication')) {
    return new ProviderError({
      kind: 'auth',
      friendly: `${provider} rejected the API key. Verify it on the provider's dashboard, then re-paste in Account → Preferences → AI Assist.`,
      providerMessage: trimmed,
      provider,
      status,
    });
  }
  if (status === 429) {
    return new ProviderError({
      kind: 'rate_limit',
      friendly: `${provider} rate-limited the request. Wait a few seconds + retry; if it persists, your tier may be throttled.`,
      providerMessage: trimmed,
      provider,
      status,
    });
  }
  if (status === 404 || (status === 400 && text.includes('model'))) {
    return new ProviderError({
      kind: 'model_not_found',
      friendly: `${provider} doesn't recognize the configured model. Open Account → Preferences → AI Assist and pick a different model name.`,
      providerMessage: trimmed,
      provider,
      status,
    });
  }
  if (status >= 500) {
    return new ProviderError({
      kind: 'server_error',
      friendly: `${provider} is having trouble (HTTP ${status}). Try again in a moment.`,
      providerMessage: trimmed,
      provider,
      status,
    });
  }
  if (status >= 400) {
    return new ProviderError({
      kind: 'bad_request',
      friendly: `${provider} rejected the request (HTTP ${status}). See provider message for details.`,
      providerMessage: trimmed,
      provider,
      status,
    });
  }
  return new ProviderError({
    kind: 'unknown',
    friendly: `${provider} returned an unexpected response.`,
    providerMessage: trimmed,
    provider,
    status,
  });
}

// Classify a thrown fetch error (no HTTP response — DNS / TLS / abort).
function fromFetchError({ provider, err }) {
  const msg = String(err?.message || err);
  if (msg.includes('aborted') || msg.includes('timeout')) {
    return new ProviderError({
      kind: 'network',
      friendly: `${provider} took too long to respond. Check the endpoint URL + your network, then retry.`,
      providerMessage: msg,
      provider,
    });
  }
  if (msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN') || msg.includes('getaddrinfo')) {
    return new ProviderError({
      kind: 'network',
      friendly: `Couldn't resolve ${provider} hostname. Check the endpoint URL.`,
      providerMessage: msg,
      provider,
    });
  }
  if (msg.includes('ECONNREFUSED') || msg.includes('socket hang up')) {
    return new ProviderError({
      kind: 'network',
      friendly: `Connection refused by ${provider}. Verify the endpoint URL + that the host is reachable.`,
      providerMessage: msg,
      provider,
    });
  }
  if (msg.includes('certificate') || msg.includes('TLS') || msg.includes('ssl')) {
    return new ProviderError({
      kind: 'network',
      friendly: `TLS handshake with ${provider} failed. Likely an http vs https mix-up in the endpoint URL.`,
      providerMessage: msg,
      provider,
    });
  }
  return new ProviderError({
    kind: 'network',
    friendly: `Couldn't reach ${provider}. Check the endpoint URL + your network.`,
    providerMessage: msg,
    provider,
  });
}

module.exports = { ProviderError, fromResponse, fromFetchError };
