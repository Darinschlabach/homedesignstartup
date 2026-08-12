import { NextResponse } from 'next/server';
import { CreateOrganizationSchema } from '@aihd/api-client';
import { requireUser } from '@/lib/projects';
import { createServiceClient } from '@/lib/supabase/admin';
import { writeAuditLog } from '@/lib/audit';

export async function GET() {
  try {
    const { supabase } = await requireUser();
    const { data, error } = await supabase.from('organizations').select('*').order('created_at');
    if (error) throw error;
    return NextResponse.json({ organizations: data });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireUser();
    const body = CreateOrganizationSchema.parse(await request.json());
    const admin = createServiceClient();

    const { data: org, error } = await admin
      .from('organizations')
      .insert({
        name: body.name,
        slug: body.slug,
        plan: 'team',
      })
      .select('*')
      .single();
    if (error) throw error;

    await admin.from('organization_members').insert({
      organization_id: org.id,
      user_id: user.id,
      role: 'owner',
    });

    await admin.from('workspaces').insert({
      type: 'org',
      name: body.name,
      organization_id: org.id,
    });

    await writeAuditLog({
      organizationId: org.id,
      actorUserId: user.id,
      action: 'organization.created',
      resourceType: 'organization',
      resourceId: org.id,
    });

    return NextResponse.json(org, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
