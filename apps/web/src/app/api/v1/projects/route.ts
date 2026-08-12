import { NextResponse } from 'next/server';
import { hashApiKey } from '@/lib/api-keys';
import { createServiceClient } from '@/lib/supabase/admin';
import { writeAuditLog } from '@/lib/audit';

async function authenticateApiKey(request: Request) {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const raw = header.slice('Bearer '.length).trim();
  const hash = hashApiKey(raw);
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('api_keys')
    .select('*')
    .eq('key_hash', hash)
    .is('revoked_at', null)
    .maybeSingle();
  if (!data) return null;
  await supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id);
  return data;
}

export async function GET(request: Request) {
  const key = await authenticateApiKey(request);
  if (!key) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();
  const { data: workspaces } = await supabase
    .from('workspaces')
    .select('id')
    .eq('organization_id', key.organization_id);

  const ids = (workspaces ?? []).map((w) => w.id);
  const { data: projects } = await supabase
    .from('projects')
    .select('id, name, building_type, status, updated_at')
    .in('workspace_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);

  await writeAuditLog({
    organizationId: key.organization_id,
    action: 'api.projects.list',
    resourceType: 'api_key',
    resourceId: key.id,
  });

  return NextResponse.json({
    organizationId: key.organization_id,
    projects: projects ?? [],
  });
}
