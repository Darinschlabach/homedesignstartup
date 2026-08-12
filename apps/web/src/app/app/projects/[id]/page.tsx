import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { ensureInitialRevision, parseModel } from '@/lib/projects';
import { DesignWorkspace } from '@/components/design-workspace';

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  const { data: project } = await supabase
    .from('projects')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (!project) notFound();

  await ensureInitialRevision({
    projectId: project.id,
    buildingType: project.building_type,
    name: project.name,
    userId: user.id,
  });

  const { data: revision } = await supabase
    .from('building_revisions')
    .select('*')
    .eq('project_id', project.id)
    .order('revision', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: conversation } = await supabase
    .from('conversations')
    .select('*')
    .eq('project_id', project.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  let conversationId = conversation?.id;
  if (!conversationId) {
    const { data: created } = await supabase
      .from('conversations')
      .insert({ project_id: project.id, title: 'Design conversation' })
      .select('*')
      .single();
    conversationId = created?.id;
  }

  const { data: messages } = conversationId
    ? await supabase
        .from('messages')
        .select('id, role, content, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
    : { data: [] };

  const model = parseModel(revision?.model);

  return (
    <DesignWorkspace
      projectId={project.id}
      projectName={project.name}
      conversationId={conversationId!}
      initialModel={model}
      initialRevision={revision?.revision ?? 1}
      initialMessages={(messages ?? []).map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant' | 'system' | 'tool',
        content: m.content,
      }))}
    />
  );
}
