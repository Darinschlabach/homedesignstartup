'use client';

import { useState } from 'react';
import { Button, Panel } from '@aihd/ui';

export function BillingPanel({ workspaceId }: { workspaceId: string }) {
  const [message, setMessage] = useState<string | null>(null);

  async function checkout(plan: 'pro' | 'team' | 'enterprise') {
    const res = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, plan, seatCount: plan === 'pro' ? 1 : 5 }),
    });
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
      return;
    }
    setMessage(data.message ?? JSON.stringify(data));
  }

  return (
    <Panel title="Billing">
      <div className="stack">
        <p className="muted">
          Consumer Pro and team seats unlock higher AI/render limits. Enterprise adds SSO and API
          access.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={() => checkout('pro')}>
            Upgrade Pro
          </Button>
          <Button variant="secondary" onClick={() => checkout('team')}>
            Upgrade Team
          </Button>
          <Button variant="secondary" onClick={() => checkout('enterprise')}>
            Talk Enterprise
          </Button>
        </div>
        {message ? <p className="muted">{message}</p> : null}
      </div>
    </Panel>
  );
}
