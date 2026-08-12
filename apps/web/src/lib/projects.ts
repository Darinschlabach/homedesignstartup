import type { BuildingModelV1 } from '@aihd/domain';
import { checksumModel, createEmptyBuildingModel, validateModel } from '@aihd/domain';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/admin';

export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    throw new Error('Unauthorized');
  }
  return { supabase, user };
}

export async function getPersonalWorkspace(userId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('workspaces')
    .select('*')
    .eq('type', 'personal')
    .eq('owner_user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getLatestRevision(projectId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('building_revisions')
    .select('*')
    .eq('project_id', projectId)
    .order('revision', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getRevision(projectId: string, revision: number) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('building_revisions')
    .select('*')
    .eq('project_id', projectId)
    .eq('revision', revision)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; message?: string };
  return (
    e.code === '23505' ||
    Boolean(e.message?.includes('building_revisions_project_id_revision_key'))
  );
}

/**
 * Persist a new building revision.
 * Concurrency-safe: retries on unique (project_id, revision) collisions
 * so parallel tool commits cannot race on the same next revision number.
 */
export async function commitRevision(options: {
  projectId: string;
  model: BuildingModelV1;
  userId: string;
  reason?: string;
  maxAttempts?: number;
}) {
  const model = validateModel(options.model);
  const checksum = await checksumModel(model);
  const admin = createServiceClient();
  const maxAttempts = options.maxAttempts ?? 8;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const latest = await getLatestRevision(options.projectId);
    const nextRevision = (latest?.revision ?? 0) + 1;

    const { data, error } = await admin
      .from('building_revisions')
      .insert({
        project_id: options.projectId,
        revision: nextRevision,
        model,
        checksum,
        created_by: options.userId,
        reason: options.reason ?? null,
      })
      .select('*')
      .single();

    if (!error) return data;

    lastError = error;
    if (isUniqueViolation(error) && attempt < maxAttempts) {
      // Another writer took this revision number — retry with a fresh MAX+1.
      continue;
    }
    throw error;
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to commit revision after retries');
}

/** Re-commit a prior snapshot as a new revision (preserves audit history). */
export async function restoreRevision(options: {
  projectId: string;
  userId: string;
  fromRevision?: number;
  reason?: string;
}) {
  const latest = await getLatestRevision(options.projectId);
  if (!latest) throw new Error('No revisions to restore');
  const targetNumber = options.fromRevision ?? latest.revision - 1;
  if (targetNumber < 1) throw new Error('Nothing to undo');

  const prior = await getRevision(options.projectId, targetNumber);
  if (!prior) throw new Error(`Revision ${targetNumber} not found`);

  const model = parseModel(prior.model);
  return commitRevision({
    projectId: options.projectId,
    model,
    userId: options.userId,
    reason: options.reason ?? `Undo to revision ${targetNumber}`,
  });
}

export async function ensureInitialRevision(options: {
  projectId: string;
  buildingType: 'home' | 'barn' | 'shop';
  name: string;
  userId: string;
}) {
  const existing = await getLatestRevision(options.projectId);
  if (existing) return existing;
  return commitRevision({
    projectId: options.projectId,
    model: createEmptyBuildingModel(options.buildingType, options.name),
    userId: options.userId,
    reason: 'Initial empty model',
  });
}

export function parseModel(raw: unknown): BuildingModelV1 {
  return validateModel(raw);
}
