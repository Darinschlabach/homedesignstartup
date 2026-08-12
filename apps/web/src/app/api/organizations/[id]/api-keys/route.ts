import { NextResponse } from 'next/server';
import { CreateApiKeySchema } from '@aihd/api-client';
import { generateApiKey } from '@/lib/api-keys';
import { requireUser } from '@/lib/projects';
import { writeAuditLog } from '@/lib/audit';

export async function POST(request: Request) {
  try {
    const { supabase, user } = await requireUser();
    const body = CreateApiKeySchema.parse(await request.json());
    const generated = generateApiKey();

    const { data, error } = await supabase
      .from('api_keys')
      .insert({
        organization_id: body.organizationId,
        name: body.name,
        key_hash: generated.hash,
        key_prefix: generated.prefix,
        scopes: body.scopes,
        created_by: user.id,
      })
      .select('id, name, key_prefix, scopes, created_at')
      .single();

    if (error) throw error;

    await writeAuditLog({
      organizationId: body.organizationId,
      actorUserId: user.id,
      action: 'api_key.created',
      resourceType: 'api_key',
      resourceId: data.id,
    });

    return NextResponse.json({
      ...data,
      apiKey: generated.raw,
      warning: 'Store this key now. It will not be shown again.',
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
