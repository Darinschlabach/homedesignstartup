import { NextResponse } from 'next/server';
import { requireUser, restoreRevision, parseModel } from '@/lib/projects';

/** POST — undo by re-committing a prior revision snapshot. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id: projectId } = await context.params;
    const { user } = await requireUser();
    const body = (await request.json().catch(() => ({}))) as {
      fromRevision?: number;
      reason?: string;
    };

    const row = await restoreRevision({
      projectId,
      userId: user.id,
      fromRevision: body.fromRevision,
      reason: body.reason ?? 'Undo',
    });

    return NextResponse.json({
      model: parseModel(row.model),
      revision: row.revision,
      restoredFrom: body.fromRevision ?? row.revision - 1,
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 400 },
    );
  }
}
