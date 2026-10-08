// Feeds a provider-fetched message payload into the generic inbound
// ingestor. Shared by the live webhook receivers (routes/inboundProviders)
// and the catch-up sweep the renewal scheduler runs after a subscription
// is recreated, so both paths hit the exact same dedup / auto-loop /
// reply / auto-create pipeline.
//
// Goes via the real HTTP endpoint rather than calling the handler
// directly so behaviour is identical to an externally-fed payload.

async function feedToGeneric(payload) {
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('INBOUND_WEBHOOK_SECRET not set; provider adapters require it');
  }
  const body = JSON.stringify(payload);
  const r = await fetch(`http://localhost:${process.env.PORT || 3001}/api/inbound/generic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': secret },
    body,
  });
  // Must throw on a non-2xx. Swallowing the status here meant an oversized
  // payload (413) or any 5xx vanished without a row, a log, or a retry —
  // the message looked like it had never been delivered at all. Graph does
  // not re-send a notification we already acknowledged, so a lost one is
  // lost until someone replays it by hand.
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(
      `inbound/generic ${r.status} (payload ${body.length} bytes, ` +
      `${(payload.attachments || []).length} attachments): ${text.slice(0, 200)}`
    );
  }
  return await r.json().catch(() => ({}));
}

module.exports = { feedToGeneric };
