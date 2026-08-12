import { createClient } from '@/lib/supabase/server';
import { BillingPanel } from '@/components/billing-panel';

export default async function BillingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id')
    .eq('type', 'personal')
    .eq('owner_user_id', user!.id)
    .maybeSingle();

  return (
    <main className="dash">
      <header className="dash-header">
        <div>
          <h1>Plans & Billing</h1>
          <p className="muted">Upgrade for more AI turns, renders, and team seats.</p>
        </div>
      </header>
      {workspace ? <BillingPanel workspaceId={workspace.id} /> : null}
    </main>
  );
}
