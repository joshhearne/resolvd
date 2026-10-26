// Pure-function tests for SLA webhook payloads and matching.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import nodeCrypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { buildRequest, buildResolveRequest, matchesHook, maskTarget, validateTarget } = require('../services/slaWebhooks');

const ticket = { id: 42, internal_ref: 'SUP-0042', title: 'VPN <down> & out', effective_priority: 1, project_name: 'Support' };
const at = new Date('2026-10-26T12:00:00Z');

describe('buildRequest', () => {
  it('slack: Block Kit with escaped text and a ticket link', () => {
    const req = buildRequest({ kind: 'slack', target: 'https://hooks.slack.com/x' }, { event: 'breach_resolve', ticket, occurredAt: at });
    expect(req.url).toBe('https://hooks.slack.com/x');
    const body = JSON.parse(req.body);
    expect(body.text).toBe('Resolve SLA breached: SUP-0042 — VPN <down> & out');
    expect(body.blocks[0].text.text).toContain('VPN &lt;down&gt; &amp; out');
    expect(body.blocks[0].text.text).toMatch(/<http[^|]+\/tickets\/42\|SUP-0042>/);
    expect(body.blocks[1].elements[0].text).toBe('Priority P1 · Project Support');
  });

  it('teams: Adaptive Card with an open-ticket action', () => {
    const body = JSON.parse(buildRequest({ kind: 'teams', target: 'https://x.logic.azure.com/y' }, { event: 'breach_response', ticket }).body);
    const card = body.attachments[0];
    expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card.content.body[0].text).toBe('Response SLA breached');
    expect(card.content.actions[0].url).toMatch(/\/tickets\/42$/);
  });

  it('pagerduty: trigger with per-ticket-clock dedup key and priority severity', () => {
    const req = buildRequest({ kind: 'pagerduty', target: 'R0UTINGKEY' }, { event: 'breach_response', ticket, occurredAt: at });
    expect(req.url).toBe('https://events.pagerduty.com/v2/enqueue');
    const body = JSON.parse(req.body);
    expect(body).toMatchObject({ routing_key: 'R0UTINGKEY', event_action: 'trigger', dedup_key: 'resolvd-ticket-42-response' });
    expect(body.payload.severity).toBe('critical');
    expect(req.dedupKey).toBe('resolvd-ticket-42-response');
    const warn = JSON.parse(buildRequest({ kind: 'pagerduty', target: 'K' }, { event: 'warning_resolve', ticket }).body);
    expect(warn.payload.severity).toBe('warning');
    expect(warn.dedup_key).toBe('resolvd-ticket-42-resolve');
  });

  it('pagerduty resolve reuses the dedup key', () => {
    expect(JSON.parse(buildResolveRequest({ target: 'K' }, 'resolvd-ticket-42-response').body))
      .toEqual({ routing_key: 'K', event_action: 'resolve', dedup_key: 'resolvd-ticket-42-response' });
  });

  it('generic: JSON body, signed over timestamp.body when a secret is set', () => {
    const req = buildRequest({ kind: 'generic', target: 'https://e.x/h', secret: 's3cret' }, { event: 'breach_resolve', ticket, occurredAt: at });
    const body = JSON.parse(req.body);
    expect(body).toMatchObject({ event: 'breach_resolve', ticket: { id: 42, ref: 'SUP-0042', priority: 1 } });
    expect(req.headers['X-Resolvd-Timestamp']).toBe(String(at.getTime() / 1000));
    const expected = nodeCrypto.createHmac('sha256', 's3cret').update(`${req.headers['X-Resolvd-Timestamp']}.${req.body}`).digest('hex');
    expect(req.headers['X-Resolvd-Signature']).toBe(`sha256=${expected}`);
    const unsigned = buildRequest({ kind: 'generic', target: 'https://e.x/h' }, { event: 'breach_resolve', ticket });
    expect(unsigned.headers['X-Resolvd-Signature']).toBeUndefined();
  });
});

describe('matchesHook', () => {
  const hook = { enabled: true, events: ['breach_resolve'], project_id: null, max_priority: 2 };
  it('filters by event, project and priority ceiling', () => {
    expect(matchesHook(hook, { event: 'breach_resolve', projectId: 7, priority: 2 })).toBe(true);
    expect(matchesHook(hook, { event: 'breach_resolve', projectId: 7, priority: 3 })).toBe(false);
    expect(matchesHook(hook, { event: 'breach_response', projectId: 7, priority: 1 })).toBe(false);
    expect(matchesHook({ ...hook, project_id: 3 }, { event: 'breach_resolve', projectId: 7, priority: 1 })).toBe(false);
    expect(matchesHook({ ...hook, enabled: false }, { event: 'breach_resolve', projectId: 7, priority: 1 })).toBe(false);
  });
});

describe('maskTarget / validateTarget', () => {
  it('never shows the credential', () => {
    expect(maskTarget('slack', 'https://hooks.slack.com/services/T0/B0/abcdWXYZ')).toBe('hooks.slack.com/…WXYZ');
    expect(maskTarget('pagerduty', 'abcdefabcdefabcdefabcdefabcd1234')).toBe('••••1234');
  });
  it('checks the destination shape per kind', () => {
    expect(validateTarget('slack', 'http://hooks.slack.com/x')).toMatch(/https/);
    expect(validateTarget('slack', 'https://hooks.slack.com/x')).toBeNull();
    expect(validateTarget('generic', 'http://10.0.0.5/hook')).toBeNull();
    expect(validateTarget('pagerduty', 'short')).toMatch(/key/);
    expect(validateTarget('pagerduty', 'a'.repeat(32))).toBeNull();
  });
});
