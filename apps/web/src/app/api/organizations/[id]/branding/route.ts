import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/projects';
import { writeAuditLog } from '@/lib/audit';

const BodySchema = z.object({
  logoUrl: z.string().url().optional(),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  companyName: z.string().min(1).max(120).optional(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const { supabase, user } = await requireUser();
    const body = BodySchema.parse(await request.json());

    const { data: existing } = await supabase
      .from('organizations')
      .select('branding')
      .eq('id', id)
      .maybeSingle();

    const branding = {
      ...((existing?.branding as Record<string, unknown>) ?? {}),
      ...body,
    };

    const { data, error } = await supabase
      .from('organizations')
      .update({ branding, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    await writeAuditLog({
      organizationId: id,
      actorUserId: user.id,
      action: 'branding.updated',
      resourceType: 'organization',
      resourceId: id,
      metadata: branding,
    });

    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
