import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/projects';
import { inngest, events } from '@/lib/inngest/client';

const BodySchema = z.object({
  kind: z.enum(['pdf', 'dxf', 'gltf']),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id: projectId } = await context.params;
    const { supabase, user } = await requireUser();
    const body = BodySchema.parse(await request.json());

    const type =
      body.kind === 'pdf' ? 'export_pdf' : body.kind === 'dxf' ? 'export_dxf' : 'export_gltf';

    const { data: job, error } = await supabase
      .from('jobs')
      .insert({
        project_id: projectId,
        type,
        status: 'queued',
        payload: { kind: body.kind },
        created_by: user.id,
      })
      .select('*')
      .single();

    if (error) throw error;

    await inngest.send({
      name: events.exportRequested,
      data: { jobId: job.id, projectId, kind: body.kind },
    });

    return NextResponse.json(job, { status: 202 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
