import { createClient } from '@/lib/supabase/server';
import { NewProjectButton } from '@/components/new-project-button';
import { ProjectsBrowser, type ProjectListItem } from '@/components/projects-browser';

export default async function ProjectsPage() {
  const supabase = await createClient();

  const { data: workspaces } = await supabase.from('workspaces').select('id, type');
  const workspaceIds = (workspaces ?? []).map((w) => w.id);
  const personal = workspaces?.find((w) => w.type === 'personal');

  const { data: projects } = workspaceIds.length
    ? await supabase
        .from('projects')
        .select('id, name, building_type, status, updated_at')
        .in('workspace_id', workspaceIds)
        .order('updated_at', { ascending: false })
    : { data: [] };

  const ids = (projects ?? []).map((p) => p.id);
  const { data: members } = ids.length
    ? await supabase.from('project_members').select('project_id').in('project_id', ids)
    : { data: [] as Array<{ project_id: string }> };

  const sharedIds = new Set((members ?? []).map((m) => m.project_id));
  const items: ProjectListItem[] = (projects ?? []).map((project) => ({
    ...project,
    shared: sharedIds.has(project.id),
  }));

  return (
    <main className="dash">
      <header className="dash-header">
        <div>
          <h1>Projects</h1>
          <p className="muted">All your projects in one place.</p>
        </div>
        <NewProjectButton workspaceId={personal?.id} withIcon />
      </header>

      {items.length === 0 ? (
        <div className="empty-panel">
          <h3>No projects yet</h3>
          <p className="muted">Start with a new project and describe what you want to build.</p>
        </div>
      ) : (
        <ProjectsBrowser projects={items} />
      )}
    </main>
  );
}
