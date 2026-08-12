'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BuildingIcon,
  Button,
  FieldInput,
  Label,
  LockIcon,
  MailIcon,
  PasswordInput,
  UserIcon,
} from '@aihd/ui';
import { createClient } from '@/lib/supabase/client';

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.9z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 16.1 19 13 24 13c3.1 0 5.8 1.1 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.6 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 10-2 13.5-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.1H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l.1.1 6.2 5.2C39.2 36.3 44 31 44 24c0-1.3-.1-2.7-.4-3.9z"
      />
    </svg>
  );
}

function isValidPassword(value: string) {
  return value.length >= 8 && /\d/.test(value);
}

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [studioName, setStudioName] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!acceptedTerms) {
      setError('Please agree to the Terms of Service and Privacy Policy.');
      return;
    }
    if (!isValidPassword(password)) {
      setError('Password must be at least 8 characters and include a number.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    const displayName = `${firstName.trim()} ${lastName.trim()}`.trim();
    const supabase = createClient();
    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          display_name: displayName,
          studio_name: studioName.trim() || null,
        },
      },
    });
    setLoading(false);
    if (signUpError) {
      setError(signUpError.message);
      return;
    }
    router.push('/app');
    router.refresh();
  }

  return (
    <div className="auth-page">
      <div className="auth-panel auth-panel-wide">
        <header className="auth-panel-header">
          <h1>Create your studio</h1>
        </header>

        <form className="auth-form" onSubmit={onSubmit}>
          <div>
            <Label htmlFor="first-name">First name</Label>
            <FieldInput
              id="first-name"
              icon={<UserIcon />}
              placeholder="Enter your first name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              autoComplete="given-name"
              required
            />
          </div>

          <div>
            <Label htmlFor="last-name">Last name</Label>
            <FieldInput
              id="last-name"
              icon={<UserIcon />}
              placeholder="Enter your last name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              autoComplete="family-name"
              required
            />
          </div>

          <div>
            <Label htmlFor="email">Email</Label>
            <FieldInput
              id="email"
              type="email"
              icon={<MailIcon />}
              placeholder="Enter your email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </div>

          <div>
            <Label htmlFor="password">Password</Label>
            <PasswordInput
              id="password"
              icon={<LockIcon />}
              placeholder="Create a password"
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
            <p className="field-hint">
              Password must be at least 8 characters and include a number.
            </p>
          </div>

          <div>
            <Label htmlFor="confirm-password">Confirm password</Label>
            <PasswordInput
              id="confirm-password"
              icon={<LockIcon />}
              placeholder="Confirm your password"
              minLength={8}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>

          <div>
            <Label htmlFor="studio-name">Studio name (optional)</Label>
            <FieldInput
              id="studio-name"
              icon={<BuildingIcon />}
              placeholder="Enter your studio or company name"
              value={studioName}
              onChange={(e) => setStudioName(e.target.value)}
              autoComplete="organization"
            />
            <p className="field-hint">You can change this later in your settings.</p>
          </div>

          <label className="auth-terms">
            <input
              type="checkbox"
              checked={acceptedTerms}
              onChange={(e) => setAcceptedTerms(e.target.checked)}
            />
            <span>
              I agree to the{' '}
              <Link href="/terms" className="auth-link">
                Terms of Service
              </Link>{' '}
              and{' '}
              <Link href="/privacy" className="auth-link">
                Privacy Policy
              </Link>
              .
            </span>
          </label>

          {error ? <p className="auth-error">{error}</p> : null}

          <Button type="submit" className="auth-submit" disabled={loading}>
            {loading ? 'Creating…' : 'Create account'}
          </Button>

          <div className="auth-divider" role="separator">
            <span>or</span>
          </div>

          <button type="button" className="btn btn-secondary auth-oauth" disabled>
            <GoogleIcon />
            Continue with Google
          </button>

          <p className="auth-footer muted">
            Already have an account?{' '}
            <Link href="/login" className="auth-link">
              Sign in
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
