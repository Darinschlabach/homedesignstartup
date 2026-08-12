import { createServer } from 'node:http';
import { exportSceneDescriptor, validateModel } from '@aihd/domain';

/**
 * Stub GPU render worker.
 * Deploy to Modal/RunPod later and replace the stub body with Blender/Cycles.
 */
const port = Number(process.env.PORT ?? 8787);

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'render-worker' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/render') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      jobId: string;
      projectId: string;
      camera?: string;
      scene?: unknown;
      model?: unknown;
    };

    const scene =
      body.scene ??
      (body.model ? exportSceneDescriptor(validateModel(body.model)) : null);

    // Placeholder: a real worker would write a PNG to object storage.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jobId: body.jobId,
        projectId: body.projectId,
        camera: body.camera ?? 'corner',
        status: 'rendered_stub',
        meshCount: Array.isArray((scene as { meshes?: unknown[] } | null)?.meshes)
          ? (scene as { meshes: unknown[] }).meshes.length
          : 0,
      }),
    );
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}).listen(port, () => {
  console.log(`Render worker listening on :${port}`);
});
