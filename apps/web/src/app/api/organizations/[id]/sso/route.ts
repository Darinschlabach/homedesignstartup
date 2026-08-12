import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/projects';
import { writeAuditLog } from '@/lib/audit';

const BodySchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(['saml', 'oidc']).default('saml'),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const { supabase, user } = await requireUser();
    const body = BodySchema.parse(await request.json());

    const { data, error } = await supabase
      .from('organizations')
      .update({
        sso_enabled: body.enabled,
        branding: { ssoProvider: body.provider },
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    await writeAuditLog({
      organizationId: id,
      actorUserId: user.id,
      action: body.enabled ? 'sso.enabled' : 'sso.disabled',
      resourceType: 'organization',
      resourceId: id,
      metadata: { provider: body.provider },
    });

    return NextResponse.json({
      organization: data,
      note: body.enabled
        ? 'SSO flag enabled. Connect SAML/OIDC IdP in Supabase Auth / enterprise identity bridge before production use.'
        : 'SSO disabled.',
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
