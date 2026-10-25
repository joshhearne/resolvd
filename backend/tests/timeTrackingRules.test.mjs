import { describe, it, expect } from 'vitest';
import rules from '../services/timeTrackingRules.js';

const {
  DEFAULT_SETTINGS, elapsedSeconds, suggestedMinutes, autoStartDecision,
  shouldDiscardOnLeave, needsWarning, canChooseVisibility, resolveVisibility,
  formatDuration, validateEntry, cleanSettingsPatch,
} = rules;

const NOW = new Date('2026-10-25T12:00:00Z');
const S = { ...DEFAULT_SETTINGS };

describe('elapsedSeconds', () => {
  it('adds live time to banked time while running', () => {
    const t = { accumulated_seconds: 120, running_since: '2026-10-25T11:58:00Z' };
    expect(elapsedSeconds(t, NOW)).toBe(240);
  });
  it('reports banked time only while paused', () => {
    expect(elapsedSeconds({ accumulated_seconds: 90, running_since: null }, NOW)).toBe(90);
  });
  it('never goes negative on clock skew', () => {
    const t = { accumulated_seconds: 0, running_since: '2026-10-25T12:05:00Z' };
    expect(elapsedSeconds(t, NOW)).toBe(0);
  });
});

describe('suggestedMinutes', () => {
  it('rounds a quick fix up to one minute', () => expect(suggestedMinutes(20)).toBe(1));
  it('rounds to nearest minute otherwise', () => expect(suggestedMinutes(150)).toBe(3));
  it('is zero with no time', () => expect(suggestedMinutes(0)).toBe(0));
});

describe('autoStartDecision', () => {
  const base = { settings: S, trigger: 'take', ticket: { assigned_to: 7 }, userId: 7, othersRunning: 0, isTerminal: false };
  it('starts when taking a ticket solo', () => {
    expect(autoStartDecision(base).start).toBe(true);
  });
  it('respects the per-trigger toggles', () => {
    expect(autoStartDecision({ ...base, trigger: 'open' }).reason).toBe('off');
    expect(autoStartDecision({ ...base, trigger: 'open', settings: { ...S, auto_start_on_open: true } }).start).toBe(true);
  });
  it('skips when someone else has a clock running', () => {
    expect(autoStartDecision({ ...base, othersRunning: 1 }).reason).toBe('not_solo');
  });
  it('skips when assigned to another tech', () => {
    expect(autoStartDecision({ ...base, ticket: { assigned_to: 8 } }).reason).toBe('assigned_elsewhere');
  });
  it('allows an unassigned ticket', () => {
    expect(autoStartDecision({ ...base, ticket: { assigned_to: null } }).start).toBe(true);
  });
  it('skips terminal tickets and disabled tracking', () => {
    expect(autoStartDecision({ ...base, isTerminal: true }).reason).toBe('terminal');
    expect(autoStartDecision({ ...base, settings: { ...S, enabled: false } }).reason).toBe('disabled');
  });
});

describe('shouldDiscardOnLeave', () => {
  const auto = { auto_started: true, status_at_start: 'Open' };
  const manual = { auto_started: false, status_at_start: 'Open' };
  it('discards an untouched auto-started timer', () => {
    expect(shouldDiscardOnLeave({ settings: S, timer: auto, currentStatus: 'Open' })).toBe(true);
  });
  it('keeps it once the status has moved', () => {
    expect(shouldDiscardOnLeave({ settings: S, timer: auto, currentStatus: 'In Progress' })).toBe(false);
  });
  it('leaves manual timers alone in auto_started mode', () => {
    expect(shouldDiscardOnLeave({ settings: S, timer: manual, currentStatus: 'Open' })).toBe(false);
  });
  it('covers manual timers in all mode, nothing when off', () => {
    expect(shouldDiscardOnLeave({ settings: { ...S, discard_untouched: 'all' }, timer: manual, currentStatus: 'Open' })).toBe(true);
    expect(shouldDiscardOnLeave({ settings: { ...S, discard_untouched: 'off' }, timer: auto, currentStatus: 'Open' })).toBe(false);
  });
});

describe('needsWarning', () => {
  const timer = { accumulated_seconds: 0, running_since: '2026-10-25T11:20:00Z', warned_at: null };
  it('warns past the threshold', () => expect(needsWarning({ settings: S, timer, now: NOW })).toBe(true));
  it('stays quiet under the threshold', () => {
    expect(needsWarning({ settings: { ...S, warn_after_minutes: 60 }, timer, now: NOW })).toBe(false);
  });
  it('warns once, never while paused, and 0 disables', () => {
    expect(needsWarning({ settings: S, timer: { ...timer, warned_at: NOW }, now: NOW })).toBe(false);
    expect(needsWarning({ settings: S, timer: { ...timer, running_since: null, accumulated_seconds: 9999 }, now: NOW })).toBe(false);
    expect(needsWarning({ settings: { ...S, warn_after_minutes: 0 }, timer, now: NOW })).toBe(false);
  });
});

describe('visibility', () => {
  it('defaults to private', () => {
    expect(resolveVisibility({ settings: S, role: 'Tech', requested: undefined })).toBe('private');
  });
  it('ignores a tech asking for public when only admins choose', () => {
    expect(canChooseVisibility(S, 'Tech')).toBe(false);
    expect(resolveVisibility({ settings: S, role: 'Tech', requested: 'public' })).toBe('private');
  });
  it('lets admins and managers choose', () => {
    expect(resolveVisibility({ settings: S, role: 'Admin', requested: 'public' })).toBe('public');
    expect(resolveVisibility({ settings: S, role: 'Manager', requested: 'public' })).toBe('public');
  });
  it('lets techs choose when the admin allows it', () => {
    const open = { ...S, visibility_choice: 'handlers' };
    expect(resolveVisibility({ settings: open, role: 'Tech', requested: 'public' })).toBe('public');
  });
  it('falls back to the org default', () => {
    const pub = { ...S, default_visibility: 'public' };
    expect(resolveVisibility({ settings: pub, role: 'Tech', requested: 'private' })).toBe('public');
  });
});

describe('validateEntry', () => {
  it('requires a note describing the work', () => {
    expect(validateEntry({ minutes: 15, note: 'fixed' }, S).error).toMatch(/at least 10/);
    expect(validateEntry({ minutes: 15, note: '  Reset the print spooler  ' }, S))
      .toEqual({ minutes: 15, note: 'Reset the print spooler' });
  });
  it('rejects bad minutes', () => {
    expect(validateEntry({ minutes: 0, note: 'Reset the print spooler' }, S).error).toBeTruthy();
    expect(validateEntry({ minutes: 1.5, note: 'Reset the print spooler' }, S).error).toBeTruthy();
    expect(validateEntry({ minutes: 1441, note: 'Reset the print spooler' }, S).error).toBeTruthy();
  });
});

describe('cleanSettingsPatch', () => {
  it('keeps valid keys and drops unknown ones', () => {
    expect(cleanSettingsPatch({ enabled: false, warn_after_minutes: 45, bogus: 1 }))
      .toEqual({ enabled: false, warn_after_minutes: 45 });
  });
  it('rejects bad enum and type values', () => {
    expect(() => cleanSettingsPatch({ default_visibility: 'billable' })).toThrow();
    expect(() => cleanSettingsPatch({ enabled: 'yes' })).toThrow();
    expect(() => cleanSettingsPatch({ min_note_chars: 0 })).toThrow();
  });
});

describe('formatDuration', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(5)).toBe('5m');
    expect(formatDuration(60)).toBe('1h');
    expect(formatDuration(95)).toBe('1h 35m');
  });
});
