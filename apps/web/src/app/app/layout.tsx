import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AppSidebar } from '@/components/app-sidebar';
import { firstNameFrom, initialsFrom } from '@/lib/format';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, email')
    .eq('id', user.id)
    .maybeSingle();

  const { data: personalWorkspace } = await supabase
    .from('workspaces')
    .select('id')
    .eq('type', 'personal')
    .eq('owner_user_id', user.id)
    .maybeSingle();

  let planLabel = 'Starter Plan';
  if (personalWorkspace?.id) {
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('plan, status')
      .eq('workspace_id', personalWorkspace.id)
      .maybeSingle();
    if (subscription?.status === 'active' && subscription.plan && subscription.plan !== 'free') {
      planLabel = `${subscription.plan[0]!.toUpperCase()}${subscription.plan.slice(1)} Plan`;
    }
  }

  const displayName = profile?.display_name || firstNameFrom(null, user.email) || 'Designer';

  return (
    <div className="studio-shell">
      <AppSidebar
        displayName={displayName}
        planLabel={planLabel}
        initials={initialsFrom(profile?.display_name, user.email)}
      />
      <div className="studio-main">{children}</div>
    </div>
  );
}
