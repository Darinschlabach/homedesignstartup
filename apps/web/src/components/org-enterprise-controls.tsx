'use client';

import { useState } from 'react';
import { Button, Input, Label } from '@aihd/ui';

export function OrgEnterpriseControls(props: {
  organizationId: string;
  ssoEnabled: boolean;
  branding: { companyName?: string; primaryColor?: string };
}) {
  const [companyName, setCompanyName] = useState(props.branding.companyName ?? '');
  const [primaryColor, setPrimaryColor] = useState(props.branding.primaryColor ?? '#2f5d50');
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function toggleSso() {
    const res = await fetch(`/api/organizations/${props.organizationId}/sso`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !props.ssoEnabled, provider: 'saml' }),
    });
    const data = await res.json();
    setMessage(data.note ?? 'Updated SSO');
  }

  async function saveBranding() {
    await fetch(`/api/organizations/${props.organizationId}/branding`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyName, primaryColor }),
    });
    setMessage('Branding saved');
  }

  async function createKey() {
    const res = await fetch(`/api/organizations/${props.organizationId}/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organizationId: props.organizationId,
        name: 'Default API key',
        scopes: ['projects:read'],
      }),
    });
    const data = await res.json();
    if (data.apiKey) setApiKey(data.apiKey);
    setMessage(data.warning ?? 'API key created');
  }

  return (
    <div className="stack">
      <div>
        <Label htmlFor={`company-${props.organizationId}`}>White-label company name</Label>
        <Input
          id={`company-${props.organizationId}`}
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor={`color-${props.organizationId}`}>Primary color</Label>
        <Input
          id={`color-${props.organizationId}`}
          type="color"
          value={primaryColor}
          onChange={(e) => setPrimaryColor(e.target.value)}
        />
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <Button variant="secondary" onClick={saveBranding}>
          Save branding
        </Button>
        <Button variant="secondary" onClick={toggleSso}>
          {props.ssoEnabled ? 'Disable SSO' : 'Enable SSO'}
        </Button>
        <Button variant="secondary" onClick={createKey}>
          Create API key
        </Button>
      </div>
      {apiKey ? (
        <code style={{ fontSize: '0.8rem', wordBreak: 'break-all' }}>{apiKey}</code>
      ) : null}
      {message ? <p className="muted">{message}</p> : null}
    </div>
  );
}
