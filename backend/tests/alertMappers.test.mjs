// Mappers normalize vendor-specific webhook payloads to a uniform event
// shape. Cover happy-path + edge cases (missing fields, aliases, recovery
// vs problem, severity passthrough) per preset.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PRESETS, resolvePriority } = require('../services/alertMappers');

describe('alertMappers — action1 preset', () => {
  const action1 = PRESETS.action1.mapper;

  it('maps a triggered alert with flat field names', () => {
    const event = action1({
      event_id: 'evt-123',
      state: 'triggered',
      severity: 'Critical',
      alert_name: 'Patch deployment failed',
      endpoint_name: 'DESKTOP-ABC',
      endpoint_id: 'ep-xyz',
      os: 'Windows 11',
      organization: 'Acme Corp',
      details: 'KB5031356 failed: exit code 0x80070103',
      url: 'https://app.action1.com/alerts/123',
    });
    expect(event.external_event_id).toBe('evt-123');
    expect(event.event_type).toBe('problem');
    expect(event.severity).toBe('Critical');
    expect(event.title).toBe('[DESKTOP-ABC] Patch deployment failed');
    expect(event.vendor_ref).toBe('https://app.action1.com/alerts/123');
    expect(event.description).toContain('**Endpoint:** DESKTOP-ABC');
    expect(event.description).toContain('**OS:** Windows 11');
    expect(event.description).toContain('**Organization:** Acme Corp');
    expect(event.description).toContain('KB5031356 failed');
    expect(event.description).toContain('[View in Action1]');
  });

  it('maps a resolved alert to recovery', () => {
    const event = action1({
      event_id: 'evt-123',
      state: 'resolved',
      severity: 'Critical',
      alert_name: 'Patch deployment failed',
      endpoint_name: 'DESKTOP-ABC',
    });
    expect(event.event_type).toBe('recovery');
  });

  it('accepts nested Endpoint / Organization shapes', () => {
    const event = action1({
      EventId: 'evt-456',
      EventType: 'firing',
      Severity: 'Warning',
      AlertName: 'Disk space low',
      Endpoint: { Id: 'ep-9', Name: 'SRV-FILES', OS: 'Windows Server 2022' },
      Organization: { Id: 'org-1', Name: 'Customer A' },
      Details: 'C: drive at 92%',
    });
    expect(event.external_event_id).toBe('evt-456');
    expect(event.event_type).toBe('problem');
    expect(event.severity).toBe('Warning');
    expect(event.title).toBe('[SRV-FILES] Disk space low');
    expect(event.description).toContain('**Endpoint:** SRV-FILES');
    expect(event.description).toContain('**OS:** Windows Server 2022');
    expect(event.description).toContain('**Organization:** Customer A');
  });

  it('falls back to alert_id when no event_id is present', () => {
    const event = action1({
      alert_id: 'alert-only-987',
      state: 'open',
      severity: 'Information',
      alert_name: 'Endpoint offline',
    });
    expect(event.external_event_id).toBe('alert-only-987');
    expect(event.event_type).toBe('problem');
  });

  it('throws when neither event_id nor alert_id is present', () => {
    expect(() => action1({ state: 'triggered', severity: 'Critical' }))
      .toThrow(/event_id/);
  });

  it('throws on an unrecognized state', () => {
    expect(() => action1({
      event_id: 'x',
      state: 'sideways',
      severity: 'Info',
    })).toThrow(/unknown state/);
  });

  it('throws on a non-object payload', () => {
    expect(() => action1(null)).toThrow();
    expect(() => action1('a string')).toThrow();
  });

  it('synthesizes a title when alert_name is absent', () => {
    const event = action1({
      event_id: 'evt-fallback',
      state: 'triggered',
      severity: 'Information',
    });
    expect(event.title).toBe('Action1 alert evt-fallback');
  });

  it('lowercases user_email', () => {
    const event = action1({
      event_id: 'evt-mail',
      state: 'triggered',
      severity: 'Information',
      alert_name: 'X',
      user_email: 'Jane.Doe@Example.Com',
    });
    expect(event.user_email).toBe('jane.doe@example.com');
    expect(event.description).toContain('**Contact:** jane.doe@example.com');
  });

  it('truncates very long titles to 200 chars', () => {
    const event = action1({
      event_id: 'evt-long',
      state: 'triggered',
      severity: 'Critical',
      alert_name: 'a'.repeat(500),
      endpoint_name: 'HOST',
    });
    expect(event.title.length).toBe(200);
  });
});

describe('alertMappers — resolvePriority (action1)', () => {
  const a1 = PRESETS.action1;

  it('maps default severities to expected priorities', () => {
    expect(resolvePriority(a1, 'Critical')).toBe(1);
    expect(resolvePriority(a1, 'High')).toBe(2);
    expect(resolvePriority(a1, 'Warning')).toBe(3);
    expect(resolvePriority(a1, 'Medium')).toBe(3);
    expect(resolvePriority(a1, 'Low')).toBe(4);
    expect(resolvePriority(a1, 'Information')).toBe(5);
    expect(resolvePriority(a1, 'Info')).toBe(5);
  });

  it('is case-insensitive', () => {
    expect(resolvePriority(a1, 'critical')).toBe(1);
    expect(resolvePriority(a1, 'WARNING')).toBe(3);
  });

  it('falls back to 3 for an unmapped severity', () => {
    expect(resolvePriority(a1, 'Bogus')).toBe(3);
    expect(resolvePriority(a1, '')).toBe(3);
  });

  it('source overrides win over the default map', () => {
    expect(resolvePriority(a1, 'Information', { Information: 2 })).toBe(2);
  });
});
