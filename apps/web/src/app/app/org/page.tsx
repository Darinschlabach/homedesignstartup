import { Badge } from '@aihd/ui';
import { createClient } from '@/lib/supabase/server';
import { CreateOrgForm } from '@/components/create-org-form';
import { OrgEnterpriseControls } from '@/components/org-enterprise-controls';

export default async function OrgPage() {
  const supabase = await createClient();
  const { data: orgs } = await supabase.from('organizations').select('*').order('created_at');

  return (
    <main className="dash">
      <header className="dash-header">
        <div>
          <h1>Organizations</h1>
          <p className="muted">Team workspaces, branding, SSO, and API access for pros.</p>
        </div>
      </header>
      <div className="project-grid">
        {(orgs ?? []).map((org) => (
          <div key={org.id} className="project-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
              <strong>{org.name}</strong>
              <Badge>{org.plan}</Badge>
            </div>
            <p className="muted">/{org.slug}</p>
            <p className="muted" style={{ marginBottom: '0.75rem' }}>
              SSO: {org.sso_enabled ? 'enabled' : 'off'}
            </p>
            <OrgEnterpriseControls
              organizationId={org.id}
              ssoEnabled={org.sso_enabled}
              branding={(org.branding as { companyName?: string; primaryColor?: string }) ?? {}}
            />
          </div>
        ))}
      </div>
      <CreateOrgForm />
    </main>
  );
}
