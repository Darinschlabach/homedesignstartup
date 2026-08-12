import { Inngest } from 'inngest';

export const inngest = new Inngest({ id: 'ai-home-design' });

export const events = {
  renderRequested: 'design/render.requested',
  exportRequested: 'design/export.requested',
  normalizeRequested: 'design/normalize.requested',
} as const;
