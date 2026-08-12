'use client';

import { FormEvent, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label } from '@aihd/ui';
import { createClient } from '@/lib/supabase/client';
import { BillingPanel } from '@/components/billing-panel';
import { initialsFrom } from '@/lib/format';

type Tab = 'profile' | 'preferences' | 'notifications' | 'security' | 'integrations';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'profile', label: 'Profile' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'security', label: 'Security' },
  { id: 'integrations', label: 'Integrations' },
];

export function SettingsPanel(props: {
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  avatarUrl: string | null;
  userId: string;
  workspaceId?: string | null;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>('profile');
  const [firstName, setFirstName] = useState(props.firstName);
  const [lastName, setLastName] = useState(props.lastName);
  const [email, setEmail] = useState(props.email);
  const [company, setCompany] = useState(props.company);
  const [avatarUrl, setAvatarUrl] = useState(props.avatarUrl);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [units, setUnits] = useState('imperial');
  const [emailNotifs, setEmailNotifs] = useState(true);
  const [productNotifs, setProductNotifs] = useState(true);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const initials = useMemo(
    () => initialsFrom(`${firstName} ${lastName}`.trim(), email),
    [email, firstName, lastName],
  );

  async function onSaveProfile(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);
    const res = await fetch('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName, lastName, email, company, avatarUrl }),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setError(data.error || 'Could not save changes.');
      return;
    }
    setMessage('Changes saved.');
    router.refresh();
  }

  async function onChangePhoto(file: File | undefined) {
    if (!file) return;
    setError(null);
    const supabase = createClient();
    const path = `${props.userId}/${crypto.randomUUID()}-${file.name}`;
    const { error: uploadError } = await supabase.storage.from('avatars').upload(path, file, {
      upsert: true,
    });
    if (uploadError) {
      setError(uploadError.message);
      return;
    }
    const { data } = supabase.storage.from('avatars').getPublicUrl(path);
    setAvatarUrl(data.publicUrl);
    setMessage('Photo updated. Click Save changes to keep it.');
  }

  async function onUpdatePassword(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (newPassword.length < 8 || !/\d/.test(newPassword)) {
      setError('New password must be at least 8 characters and include a number.');
      return;
    }
    const supabase = createClient();
    if (currentPassword) {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password: currentPassword,
      });
      if (signInError) {
        setError('Current password is incorrect.');
        return;
      }
    }
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setCurrentPassword('');
    setNewPassword('');
    setMessage('Password updated.');
  }

  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="settings-nav-link"
            data-active={tab === item.id}
            onClick={() => {
              setTab(item.id);
              setMessage(null);
              setError(null);
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <section className="settings-content">
        {tab === 'profile' ? (
          <form className="settings-profile" onSubmit={onSaveProfile}>
            <div>
              <h2>Profile Information</h2>
              <p className="muted">Update your account details.</p>
            </div>

            <div className="settings-profile-grid">
              <div className="settings-fields">
                <div className="name-row">
                  <div>
                    <Label htmlFor="settings-first">First name</Label>
                    <Input
                      id="settings-first"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <Label htmlFor="settings-last">Last name</Label>
                    <Input
                      id="settings-last"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      required
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="settings-email">Email</Label>
                  <Input
                    id="settings-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="settings-company">Company</Label>
                  <Input
                    id="settings-company"
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                    placeholder="Your studio or company name"
                  />
                </div>
              </div>

              <div className="settings-avatar-block">
                <Label>Profile picture</Label>
                {avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatarUrl} alt="" className="settings-avatar-image" />
                ) : (
                  <div className="settings-avatar-fallback">{initials}</div>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => onChangePhoto(e.target.files?.[0])}
                />
                <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>
                  Change photo
                </Button>
              </div>
            </div>

            {error ? <p className="auth-error">{error}</p> : null}
            {message ? <p className="muted">{message}</p> : null}
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </form>
        ) : null}

        {tab === 'preferences' ? (
          <div className="stack">
            <div>
              <h2>Preferences</h2>
              <p className="muted">Units, plans, and studio defaults.</p>
            </div>
            <div>
              <Label htmlFor="settings-units">Measurement units</Label>
              <select
                id="settings-units"
                className="input"
                value={units}
                onChange={(e) => setUnits(e.target.value)}
              >
                <option value="imperial">Imperial (feet / inches)</option>
                <option value="metric">Metric (meters)</option>
              </select>
            </div>
            {props.workspaceId ? <BillingPanel workspaceId={props.workspaceId} /> : null}
          </div>
        ) : null}

        {tab === 'notifications' ? (
          <div className="stack">
            <div>
              <h2>Notifications</h2>
              <p className="muted">Choose what Atelier emails you about.</p>
            </div>
            <label className="auth-terms">
              <input
                type="checkbox"
                checked={emailNotifs}
                onChange={(e) => setEmailNotifs(e.target.checked)}
              />
              <span>Email me when a render or export finishes</span>
            </label>
            <label className="auth-terms">
              <input
                type="checkbox"
                checked={productNotifs}
                onChange={(e) => setProductNotifs(e.target.checked)}
              />
              <span>Product updates and new design features</span>
            </label>
            <Button type="button" onClick={() => setMessage('Notification preferences saved.')}>
              Save changes
            </Button>
            {message ? <p className="muted">{message}</p> : null}
          </div>
        ) : null}

        {tab === 'security' ? (
          <form className="stack" onSubmit={onUpdatePassword}>
            <div>
              <h2>Security</h2>
              <p className="muted">Update your password.</p>
            </div>
            <div>
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <div>
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </div>
            {error ? <p className="auth-error">{error}</p> : null}
            {message ? <p className="muted">{message}</p> : null}
            <Button type="submit">Update password</Button>
          </form>
        ) : null}

        {tab === 'integrations' ? (
          <div className="stack">
            <div>
              <h2>Integrations</h2>
              <p className="muted">Connect Google and other tools. Coming online next.</p>
            </div>
            <div className="empty-panel">
              <strong>Google</strong>
              <p className="muted">Sign-in and Drive export will appear here once OAuth is enabled.</p>
              <Button type="button" variant="secondary" disabled>
                Connect Google
              </Button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
