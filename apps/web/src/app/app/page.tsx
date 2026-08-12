import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { NewProjectButton } from '@/components/new-project-button';
import {
  firstNameFrom,
  greetingForHour,
  projectCover,
  relativeTime,
} from '@/lib/format';

type ProjectRow = {
  id: string;
  name: string;
  building_type: string;
  status: string;
  updated_at: string;
};

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('id', user!.id)
    .maybeSingle();

  const { data: workspaces } = await supabase
    .from('workspaces')
    .select('id, type, owner_user_id')
    .order('created_at', { ascending: true });

  const workspaceIds = (workspaces ?? []).map((w) => w.id);
  const personal = workspaces?.find((w) => w.type === 'personal');

  const { data: projects } = workspaceIds.length
    ? await supabase
        .from('projects')
        .select('id, name, building_type, status, updated_at')
        .in('workspace_id', workspaceIds)
        .order('updated_at', { ascending: false })
    : { data: [] as ProjectRow[] };

  const projectList = (projects ?? []) as ProjectRow[];
  const projectIds = projectList.map((p) => p.id);

  const { data: sharedRows } = projectIds.length
    ? await supabase.from('project_members').select('project_id').in('project_id', projectIds)
    : { data: [] as Array<{ project_id: string }> };

  const { data: messages } = projectIds.length
    ? await supabase
        .from('conversations')
        .select('id, project_id')
        .in('project_id', projectIds)
    : { data: [] as Array<{ id: string; project_id: string }> };

  const conversationIds = (messages ?? []).map((c) => c.id);
  const { data: userMessages } = conversationIds.length
    ? await supabase
        .from('messages')
        .select('id')
        .in('conversation_id', conversationIds)
        .eq('role', 'user')
        .limit(1)
    : { data: [] as Array<{ id: string }> };

  const { data: revisions } = projectIds.length
    ? await supabase
        .from('building_revisions')
        .select('id, project_id, reason, created_at, model')
        .in('project_id', projectIds)
        .order('created_at', { ascending: false })
        .limit(8)
    : { data: [] as Array<{
        id: string;
        project_id: string;
        reason: string | null;
        created_at: string;
        model: unknown;
      }> };

  const { data: exportJobs } = projectIds.length
    ? await supabase
        .from('jobs')
        .select('id')
        .in('project_id', projectIds)
        .in('type', ['export_pdf', 'export_dxf', 'export_gltf'])
        .limit(1)
    : { data: [] as Array<{ id: string }> };

  const total = projectList.length;
  const inProgress = projectList.filter((p) => p.status === 'active' || p.status === 'draft').length;
  const completed = projectList.filter((p) => p.status === 'archived').length;
  const shared = new Set((sharedRows ?? []).map((r) => r.project_id)).size;

  const firstName = firstNameFrom(profile?.display_name, user?.email);
  const recent = projectList.slice(0, 5);
  const projectNameById = new Map(projectList.map((p) => [p.id, p.name]));

  const hasWalls = (revisions ?? []).some((rev) => {
    const model = rev.model as { walls?: unknown[] } | null;
    return Array.isArray(model?.walls) && model.walls.length > 0;
  });

  const checklist = [
    { label: 'Create your first project', done: total > 0 },
    { label: 'Describe your project with AI', done: (userMessages ?? []).length > 0 },
    { label: 'Generate your first floor plan', done: hasWalls },
    { label: 'Export a document', done: (exportJobs ?? []).length > 0 },
  ];

  const activity = (revisions ?? []).slice(0, 4).map((rev) => ({
    id: rev.id,
    title: rev.reason?.trim() || 'Design updated',
    project: projectNameById.get(rev.project_id) ?? 'Project',
    when: relativeTime(rev.created_at),
  }));

  return (
    <main className="dash">
      <header className="dash-header">
        <div>
          <h1>
            {greetingForHour()}, {firstName} <span aria-hidden>👋</span>
          </h1>
          <p className="muted">Here&apos;s what&apos;s happening with your projects.</p>
        </div>
        <NewProjectButton workspaceId={personal?.id} />
      </header>

      <section className="dash-stats" aria-label="Project stats">
        <article className="stat-card">
          <span>Total Projects</span>
          <strong>{total}</strong>
        </article>
        <article className="stat-card">
          <span>In Progress</span>
          <strong>{inProgress}</strong>
        </article>
        <article className="stat-card">
          <span>Completed</span>
          <strong>{completed}</strong>
        </article>
        <article className="stat-card">
          <span>Shared</span>
          <strong>{shared}</strong>
        </article>
      </section>

      <section>
        <div className="section-heading">
          <h2>Recent Projects</h2>
          <Link href="/app/projects" className="section-link">
            View all
          </Link>
        </div>
        {recent.length === 0 ? (
          <div className="empty-panel">
            <h3>No projects yet</h3>
            <p className="muted">Create a home, barn, or shop to start designing with your AI architect.</p>
          </div>
        ) : (
          <div className="recent-grid">
            {recent.map((project) => (
              <Link key={project.id} href={`/app/projects/${project.id}`} className="recent-card">
                <div
                  className="recent-thumb"
                  style={{ backgroundImage: `url(${projectCover(project.building_type, project.id)})` }}
                />
                <div className="recent-copy">
                  <strong>{project.name}</strong>
                  <span>Updated {relativeTime(project.updated_at)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="dash-bottom">
        <article className="dash-panel">
          <h2>Recent Activity</h2>
          {activity.length === 0 ? (
            <p className="muted">Activity from designs, renders, and exports will show up here.</p>
          ) : (
            <ul className="activity-list">
              {activity.map((item) => (
                <li key={item.id}>
                  <span className="activity-dot" aria-hidden />
                  <div>
                    <strong>{item.title}</strong>
                    <span className="muted">
                      {item.project} — {item.when}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="dash-panel">
          <h2>Get started</h2>
          <ul className="checklist">
            {checklist.map((item) => (
              <li key={item.label} data-done={item.done}>
                <span className="check-mark" aria-hidden>
                  {item.done ? '✓' : ''}
                </span>
                {item.label}
              </li>
            ))}
          </ul>
        </article>
      </section>
    </main>
  );
}
