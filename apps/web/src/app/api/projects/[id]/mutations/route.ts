import { NextResponse } from 'next/server';
import { BuildingMutationBatchSchema, applyAndValidate } from '@aihd/domain';
import { commitRevision, getLatestRevision, parseModel, requireUser } from '@/lib/projects';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id: projectId } = await context.params;
    const { user } = await requireUser();
    const batch = BuildingMutationBatchSchema.parse(await request.json());
    const latest = await getLatestRevision(projectId);
    if (!latest) {
      return NextResponse.json({ error: 'No revision found' }, { status: 404 });
    }

    const current = parseModel(latest.model);
    const next = applyAndValidate(current, batch.mutations);
    const revision = await commitRevision({
      projectId,
      model: next,
      userId: user.id,
      reason: batch.reason,
    });

    return NextResponse.json({
      model: next,
      revision: revision.revision,
      revisionId: revision.id,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
