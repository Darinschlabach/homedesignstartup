import { NextResponse } from 'next/server';
import { CreateProjectSchema } from '@aihd/api-client';
import { checksumModel, createEmptyBuildingModel, validateModel } from '@aihd/domain';
import { requireUser } from '@/lib/projects';
import { createServiceClient } from '@/lib/supabase/admin';

export async function GET() {
  try {
    const { supabase, user } = await requireUser();
    const { data: workspaces } = await supabase
      .from('workspaces')
      .select('id')
      .or(`owner_user_id.eq.${user.id}`);
    const ids = (workspaces ?? []).map((w) => w.id);
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .in('workspace_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return NextResponse.json({ projects: data });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, user } = await requireUser();
    const body = CreateProjectSchema.parse(await request.json());

    const { data: workspace, error: workspaceError } = await supabase
      .from('workspaces')
      .select('id')
      .eq('id', body.workspaceId)
      .maybeSingle();

    if (workspaceError) throw workspaceError;
    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found or inaccessible' }, { status: 403 });
    }

    const admin = createServiceClient();
    const { data: project, error } = await admin
      .from('projects')
      .insert({
        workspace_id: body.workspaceId,
        name: body.name,
        building_type: body.buildingType,
        status: 'active',
        created_by: user.id,
      })
      .select('*')
      .single();

    if (error) throw error;

    const model = validateModel(createEmptyBuildingModel(body.buildingType, body.name));
    const checksum = await checksumModel(model);

    const { error: revisionError } = await admin.from('building_revisions').insert({
      project_id: project.id,
      revision: 1,
      model,
      checksum,
      created_by: user.id,
      reason: 'Initial empty model',
    });
    if (revisionError) throw revisionError;

    const { error: conversationError } = await admin.from('conversations').insert({
      project_id: project.id,
      title: 'Design conversation',
    });
    if (conversationError) throw conversationError;

    return NextResponse.json(project, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not create project';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
