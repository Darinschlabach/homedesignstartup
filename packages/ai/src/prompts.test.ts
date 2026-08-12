import { describe, expect, it } from 'vitest';
import { ARCHITECT_SYSTEM_PROMPT } from './index';

describe('ai package', () => {
  it('exports architect prompt', () => {
    expect(ARCHITECT_SYSTEM_PROMPT.length).toBeGreaterThan(20);
  });
});
