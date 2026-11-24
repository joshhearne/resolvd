// License renewal reminder stages and wording (services/licenseReminders.js).

import { describe as suite, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stageFor, describe } = require('../services/licenseReminders');

suite('stageFor', () => {
  it('picks the most urgent stage due', () => {
    expect(stageFor(45)).toBe(null);
    expect(stageFor(31)).toBe(null);
    expect(stageFor(30)).toBe('d30');
    expect(stageFor(8)).toBe('d30');
    expect(stageFor(7)).toBe('d7');
    expect(stageFor(0)).toBe('d7');
  });
  it('flags a passed renewal only within the lapsed window', () => {
    expect(stageFor(-1)).toBe('lapsed');
    expect(stageFor(-30)).toBe('lapsed');
    expect(stageFor(-31)).toBe(null);
  });
});

suite('describe', () => {
  it('words upcoming renewals by auto-renew', () => {
    expect(describe({ name: 'M365', days: 7, auto_renew: true }).title).toBe('License auto-renews in 7 days: M365');
    expect(describe({ name: 'M365', days: 1, auto_renew: false }).title).toBe('License expires tomorrow: M365');
    expect(describe({ name: 'M365', days: 0, auto_renew: false }).title).toBe('License expires today: M365');
  });
  it('words passed renewals by auto-renew', () => {
    expect(describe({ name: 'Acrobat', days: -1, auto_renew: false }).title).toBe('License lapsed: Acrobat');
    const auto = describe({ name: 'Acrobat', days: -3, auto_renew: true });
    expect(auto.title).toBe('License renewal date passed: Acrobat');
    expect(auto.lead).toMatch(/3 days ago.*Update its renewal date/);
  });
});
