// Response security headers. Sits in front of every request — nginx
// can add some too (HSTS for the public origin makes sense at the
// edge), but having them here means the protections travel with the
// backend even when accessed directly during dev.
//
// CSP is intentionally permissive on inline scripts because the app
// shells some bootstrap JS in index.html (theme detection). Tighten
// later by moving that to a hashed/nonced block and dropping
// 'unsafe-inline'.

function securityHeaders(req, res, next) {
  // Clickjacking: deny framing entirely. We have no embeddable surface.
  res.setHeader('X-Frame-Options', 'DENY');
  // MIME sniffing guard.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Referrer leakage to outbound providers (AI calls, attachments).
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Disable browser features we never use.
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=()'
  );
  // HSTS: only meaningful when served over HTTPS. The cookie-secure
  // env signal is a proxy for "this install is behind HTTPS". Keep
  // the header off in plain-HTTP dev so browsers don't pin localhost
  // to HTTPS.
  if (process.env.COOKIE_SECURE === 'true') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  // Content-Security-Policy — restrict origins. Connect-src needs to
  // allow the configured FRONTEND_URL + provider hosts for AI calls
  // (Anthropic / OpenAI / Ollama LAN). 'self' covers same-origin API.
  // Style-src 'unsafe-inline' is required for emotion / inline styles
  // used by toast + theme provider; can be tightened later.
  const apiSrcs = [
    "'self'",
    'https://api.anthropic.com',
    'https://api.openai.com',
    'https://*.openai.azure.com',
    'https://openrouter.ai',
  ].join(' ');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob:",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      `connect-src ${apiSrcs}`,
    ].join('; ')
  );
  next();
}

module.exports = { securityHeaders };
