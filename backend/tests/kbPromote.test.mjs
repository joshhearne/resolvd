import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildPromoteBody, pickTargetCollection, toSteps } = require('../services/kbPromote');

describe('kbPromote', () => {
  it('turns resolution paragraphs into numbered runbook steps', () => {
    expect(toSteps('Restart the worker.\n\nCheck the queue\ndrains.')).toBe(
      '1. Restart the worker.\n2. Check the queue drains.'
    );
    expect(toSteps('Stop app\nRun migration\nStart app')).toBe('1. Stop app\n2. Run migration\n3. Start app');
  });

  it('keeps a resolution that is already a list', () => {
    const body = buildPromoteBody({
      kind: 'runbook', title: 'T', description: 'D', resolution: '- one\n- two', ref: 'G2A-1',
    });
    expect(body).toContain('## Steps\n\n- one\n- two');
    expect(body).toContain('## When to use\n\nD');
  });

  it('builds a plain article', () => {
    const body = buildPromoteBody({ kind: 'article', title: 'T', description: '', resolution: 'Fixed', ref: 'G2A-1' });
    expect(body).toContain('## Symptom\n\nOriginally reported on ticket G2A-1.');
    expect(body).toContain('## Resolution\n\nFixed');
  });

  const collections = [
    { id: 'aaa', name: 'IDS G2 KB', writable: false },
    { id: 'bbb', name: 'MOT IT Internal', writable: true },
  ];

  it('uses the project collection when writable', () => {
    const r = pickTargetCollection({
      projectCollectionId: 'bbb', internalIds: ['bbb'], collections,
    });
    expect(r.target.name).toBe('MOT IT Internal');
    expect(r.fallbackFrom).toBeNull();
  });

  it('falls back to a writable internal collection', () => {
    const r = pickTargetCollection({ projectCollectionId: 'AAA', internalIds: ['aaa', 'bbb'], collections });
    expect(r.target.name).toBe('MOT IT Internal');
    expect(r.fallbackFrom.name).toBe('IDS G2 KB');
  });

  it('prefers the promotions collection over the project mapping', () => {
    const r = pickTargetCollection({
      promoteCollectionId: 'bbb', projectCollectionId: 'aaa', internalIds: [], collections,
    });
    expect(r.target.name).toBe('MOT IT Internal');
    expect(r.fallbackFrom).toBeNull();
  });

  it('returns no target when nothing is writable', () => {
    const r = pickTargetCollection({ projectCollectionId: 'aaa', internalIds: ['aaa'], collections });
    expect(r.target).toBeNull();
  });
});
