import {
  buildConstructionDocuments,
  exportDxfLite,
  exportSceneDescriptor,
  validateModel,
} from '@aihd/domain';
import { inngest, events } from '@/lib/inngest/client';
import { createServiceClient } from '@/lib/supabase/admin';

async function markJob(
  jobId: string,
  patch: { status: string; result?: unknown; error?: string },
) {
  const supabase = createServiceClient();
  await supabase
    .from('jobs')
    .update({
      status: patch.status,
      result: patch.result ?? null,
      error: patch.error ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);
}

export const renderRequested = inngest.createFunction(
  { id: 'render-requested' },
  { event: events.renderRequested },
  async ({ event, step }) => {
    const { jobId, projectId, payload } = event.data as {
      jobId: string;
      projectId: string;
      payload?: { camera?: string };
    };

    await step.run('mark-running', async () => markJob(jobId, { status: 'running' }));

    const result = await step.run('invoke-worker-or-stub', async () => {
      const supabase = createServiceClient();
      const { data: revision } = await supabase
        .from('building_revisions')
        .select('model')
        .eq('project_id', projectId)
        .order('revision', { ascending: false })
        .limit(1)
        .maybeSingle();

      const model = validateModel(revision?.model);
      const scene = exportSceneDescriptor(model);
      const workerUrl = process.env.RENDER_WORKER_URL;

      if (workerUrl) {
        const res = await fetch(workerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId,
            projectId,
            camera: payload?.camera ?? 'corner',
            scene,
          }),
        });
        if (!res.ok) {
          throw new Error(`Render worker failed: ${await res.text()}`);
        }
        return res.json();
      }

      // Stub photoreal output until GPU worker is deployed
      const storagePath = `${projectId}/renders/${jobId}.json`;
      await supabase.storage.from('renders').upload(
        storagePath,
        JSON.stringify({ stub: true, scene, camera: payload?.camera ?? 'corner' }),
        { contentType: 'application/json', upsert: true },
      );

      await supabase.from('assets').insert({
        project_id: projectId,
        kind: 'render',
        storage_path: storagePath,
        mime_type: 'application/json',
        metadata: { stub: true, camera: payload?.camera ?? 'corner' },
      });

      return { storagePath, stub: true };
    });

    await step.run('mark-succeeded', async () =>
      markJob(jobId, { status: 'succeeded', result }),
    );

    return result;
  },
);

export const exportRequested = inngest.createFunction(
  { id: 'export-requested' },
  { event: events.exportRequested },
  async ({ event, step }) => {
    const { jobId, projectId, kind } = event.data as {
      jobId: string;
      projectId: string;
      kind: 'pdf' | 'dxf' | 'gltf';
    };

    await step.run('mark-running', async () => markJob(jobId, { status: 'running' }));

    const result = await step.run('build-export', async () => {
      const supabase = createServiceClient();
      const { data: revision } = await supabase
        .from('building_revisions')
        .select('model')
        .eq('project_id', projectId)
        .order('revision', { ascending: false })
        .limit(1)
        .maybeSingle();

      const model = validateModel(revision?.model);
      let body: string;
      let mime: string;
      let ext: string;

      if (kind === 'dxf') {
        body = exportDxfLite(model);
        mime = 'application/dxf';
        ext = 'dxf';
      } else if (kind === 'gltf') {
        body = JSON.stringify(exportSceneDescriptor(model), null, 2);
        mime = 'application/json';
        ext = 'scene.json';
      } else {
        body = JSON.stringify(buildConstructionDocuments(model), null, 2);
        mime = 'application/json';
        ext = 'docs.json';
      }

      const storagePath = `${projectId}/exports/${jobId}.${ext}`;
      await supabase.storage
        .from('exports')
        .upload(storagePath, body, { contentType: mime, upsert: true });

      await supabase.from('assets').insert({
        project_id: projectId,
        kind: kind === 'pdf' ? 'document' : 'export',
        storage_path: storagePath,
        mime_type: mime,
        metadata: { kind },
      });

      return { storagePath };
    });

    await step.run('mark-succeeded', async () =>
      markJob(jobId, { status: 'succeeded', result }),
    );
    return result;
  },
);

export const normalizeRequested = inngest.createFunction(
  { id: 'normalize-requested' },
  { event: events.normalizeRequested },
  async ({ event, step }) => {
    const { jobId } = event.data as { jobId: string };
    await step.run('complete', async () =>
      markJob(jobId, { status: 'succeeded', result: { normalized: true } }),
    );
    return { ok: true };
  },
);

export const inngestFunctions = [renderRequested, exportRequested, normalizeRequested];
