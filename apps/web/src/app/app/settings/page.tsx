import { createClient } from '@/lib/supabase/server';
import { SettingsPanel } from '@/components/settings-panel';

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user!.id)
    .maybeSingle();

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id')
    .eq('type', 'personal')
    .eq('owner_user_id', user!.id)
    .maybeSingle();

  const meta = (user?.user_metadata ?? {}) as Record<string, string | undefined>;
  const displayParts = (profile?.display_name ?? '').trim().split(/\s+/).filter(Boolean);
  const firstName = meta.first_name || displayParts[0] || '';
  const lastName = meta.last_name || displayParts.slice(1).join(' ') || '';
  const company = meta.company || meta.studio_name || '';

  return (
    <main className="dash">
      <header className="dash-header">
        <div>
          <h1>Settings</h1>
          <p className="muted">Manage your account and preferences.</p>
        </div>
      </header>
      <SettingsPanel
        userId={user!.id}
        firstName={firstName}
        lastName={lastName}
        email={profile?.email ?? user?.email ?? ''}
        company={company}
        avatarUrl={profile?.avatar_url ?? null}
        workspaceId={workspace?.id}
      />
    </main>
  );
}
