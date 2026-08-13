import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  buildSceneMeshes,
  extractShellFromModel,
  type BuildingModelV1,
} from "@aihd/domain";
import {
  resolvePreviewCamera,
  type CameraSnapshot,
  type PreviewView,
} from "./cameraPose";
import {
  getPreviewBrowser,
  previewBrowserUnavailableError,
  type PreviewRenderBackend,
} from "./previewBrowser";
import type { BrowserContext, Page } from "playwright";

export type RenderBuildingPreviewInput = {
  model: BuildingModelV1;
  view: PreviewView;
  width?: number;
  height?: number;
  currentCamera?: CameraSnapshot | null;
  projectId: string;
  revision: number;
  /** Optional staged/committed marker for asset refs */
  modelSource?: "committed" | "staged";
};

export type RenderBuildingPreviewResult = {
  success: true;
  imageGenerated: true;
  projectId: string;
  revision: number;
  view: string;
  requestedView: PreviewView;
  width: number;
  height: number;
  mediaType: "image/jpeg";
  /** data URL for model vision input */
  dataUrl: string;
  /** Filesystem path for observability (not logged as bytes) */
  assetPath: string;
  assetRef: string;
  camera: CameraSnapshot;
  renderBackend: PreviewRenderBackend;
  note?: string;
};

export type RenderBuildingPreviewFailure = {
  success: false;
  imageGenerated: false;
  error: string;
  code: string;
  projectId: string;
  revision: number;
  requestedView: PreviewView;
  renderBackend: null;
  remediation?: string[];
  diagnostics?: Record<string, unknown>;
};

const require = createRequire(import.meta.url);

function resolveThreeModuleMin(): string {
  const threeEntry = require.resolve("three");
  return path.join(path.dirname(threeEntry), "three.module.min.js");
}

/**
 * Render BuildingModelV1 with the same mesh descriptors and camera presets
 * as the live Three.js viewport (imperative WebGL via Chromium/Playwright).
 * Does not mutate the model or create a revision.
 *
 * Backend: Playwright + Chromium-compatible browser (system Chrome/Edge preferred).
 * Not a separate rendering engine — reuses buildSceneMeshes + three.js.
 */
export async function renderBuildingPreview(
  input: RenderBuildingPreviewInput,
): Promise<RenderBuildingPreviewResult | RenderBuildingPreviewFailure> {
  const width = input.width ?? 1280;
  const height = input.height ?? 720;
  const shell = extractShellFromModel(input.model);
  const buildingExtent = Math.max(
    shell?.width ?? 40,
    shell?.depth ?? 40,
    (shell?.wallHeight ?? 10) * 2,
  );

  const { camera, resolvedView, note } = resolvePreviewCamera({
    view: input.view,
    buildingExtent,
    shell: shell
      ? {
          width: shell.width,
          depth: shell.depth,
          wallHeight: shell.wallHeight,
        }
      : null,
    currentCamera: input.currentCamera,
  });

  const meshes = buildSceneMeshes(input.model);

  let page: Page | null = null;
  let browserContext: BrowserContext | null = null;
  try {
    const { browser, backend } = await getPreviewBrowser();
    const threeDir = path.dirname(resolveThreeModuleMin());
    browserContext = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    page = await browserContext.newPage();

    await page.route("http://preview.local/**", async (route) => {
      const url = new URL(route.request().url());
      const fileName = path.basename(url.pathname);
      if (fileName.endsWith(".js")) {
        const filePath = path.join(threeDir, fileName);
        try {
          const body = await fs.readFile(filePath);
          await route.fulfill({
            status: 200,
            contentType: "text/javascript",
            body,
          });
          return;
        } catch {
          // fall through
        }
      }
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!DOCTYPE html><html><body></body></html>",
      });
    });

    await page.goto("http://preview.local/", { waitUntil: "domcontentloaded" });

    await page.setContent(
      `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8" /></head>
  <body style="margin:0;background:#e8ece8;overflow:hidden">
    <canvas id="c" width="${width}" height="${height}"></canvas>
    <script type="module">
      import * as THREE from "http://preview.local/three.module.min.js";
      window.__THREE = THREE;
      window.__previewReady = true;
    </script>
  </body>
</html>`,
      { waitUntil: "domcontentloaded" },
    );

    await page.waitForFunction(
      () =>
        (window as unknown as { __previewReady?: boolean }).__previewReady ===
        true,
      null,
      { timeout: 30000 },
    );

    const dataUrl = await page.evaluate(
      ({ meshes: meshList, camera: cam, width: w, height: h }) => {
        const THREE = (window as unknown as { __THREE: typeof import("three") })
          .__THREE;
        const canvas = document.getElementById("c") as HTMLCanvasElement;
        canvas.width = w;
        canvas.height = h;

        const renderer = new THREE.WebGLRenderer({
          canvas,
          antialias: true,
          preserveDrawingBuffer: true,
          alpha: false,
        });
        renderer.setSize(w, h, false);
        renderer.setPixelRatio(1);
        renderer.shadowMap.enabled = true;
        renderer.setClearColor(0xe8ece8, 1);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xe8ece8);

        scene.add(new THREE.AmbientLight(0xffffff, 0.55));
        scene.add(new THREE.HemisphereLight(0xf5f7f5, 0xc5c0b5, 0.35));
        const dir = new THREE.DirectionalLight(0xffffff, 1.15);
        dir.position.set(45, 70, 35);
        dir.castShadow = true;
        scene.add(dir);

        const ground = new THREE.Mesh(
          new THREE.PlaneGeometry(200, 200),
          new THREE.MeshStandardMaterial({
            color: 0xdfe6df,
            roughness: 1,
            metalness: 0,
          }),
        );
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        scene.add(ground);

        const grid = new THREE.GridHelper(160, 32, 0x9aab9c, 0xcfd8d0);
        grid.position.y = 0.01;
        scene.add(grid);

        for (const mesh of meshList) {
          const mat = new THREE.MeshStandardMaterial({
            color: mesh.color,
            roughness: mesh.roughness,
            metalness: mesh.metalness,
          });

          let object: InstanceType<typeof THREE.Mesh> | null = null;
          if (mesh.kind === "box" && mesh.size) {
            const geom = new THREE.BoxGeometry(
              mesh.size.x,
              mesh.size.y,
              mesh.size.z,
            );
            object = new THREE.Mesh(geom, mat);
            object.position.set(mesh.position.x, mesh.position.y, mesh.position.z);
            object.rotation.set(
              (mesh.rotation.x * Math.PI) / 180,
              (mesh.rotation.y * Math.PI) / 180,
              (mesh.rotation.z * Math.PI) / 180,
            );
          } else if (
            mesh.kind === "extrudedPolygon" &&
            mesh.polygon &&
            mesh.polygon.length >= 3 &&
            mesh.height != null
          ) {
            const shape = new THREE.Shape();
            const first = mesh.polygon[0]!;
            shape.moveTo(first.x, first.y);
            for (let i = 1; i < mesh.polygon.length; i++) {
              const p = mesh.polygon[i]!;
              shape.lineTo(p.x, p.y);
            }
            shape.closePath();
            for (const hole of mesh.holes ?? []) {
              if (!hole || hole.length < 3) continue;
              const path = new THREE.Path();
              path.moveTo(hole[0]!.x, hole[0]!.y);
              for (let i = 1; i < hole.length; i++) {
                path.lineTo(hole[i]!.x, hole[i]!.y);
              }
              path.closePath();
              shape.holes.push(path);
            }
            const geom = new THREE.ExtrudeGeometry(shape, {
              depth: mesh.height,
              bevelEnabled: false,
            });
            // Shape XY → world XZ; extrude along +Z then rotate so depth → +Y.
            geom.rotateX(-Math.PI / 2);
            geom.translate(0, -mesh.height / 2, 0);
            object = new THREE.Mesh(geom, mat);
            object.position.set(mesh.position.x, mesh.position.y, mesh.position.z);
            object.rotation.set(
              (mesh.rotation.x * Math.PI) / 180,
              (mesh.rotation.y * Math.PI) / 180,
              (mesh.rotation.z * Math.PI) / 180,
            );
          } else if (
            mesh.kind === "triangles" &&
            mesh.positions &&
            mesh.positions.length >= 9
          ) {
            const geom = new THREE.BufferGeometry();
            geom.setAttribute(
              "position",
              new THREE.Float32BufferAttribute(mesh.positions, 3),
            );
            geom.computeVertexNormals();
            object = new THREE.Mesh(geom, mat);
          }

          if (object) {
            object.castShadow = true;
            object.receiveShadow = true;
            scene.add(object);
          }
        }

        const perspective = new THREE.PerspectiveCamera(
          cam.fov || 45,
          w / h,
          0.1,
          500,
        );
        perspective.position.set(cam.position.x, cam.position.y, cam.position.z);
        perspective.lookAt(cam.target.x, cam.target.y, cam.target.z);
        perspective.updateProjectionMatrix();

        renderer.render(scene, perspective);
        const url = canvas.toDataURL("image/jpeg", 0.9);
        renderer.dispose();
        return url;
      },
      { meshes, camera, width, height },
    );

    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
      return {
        success: false,
        imageGenerated: false,
        error: "Renderer did not return an image data URL.",
        code: "RENDER_EMPTY",
        projectId: input.projectId,
        revision: input.revision,
        requestedView: input.view,
        renderBackend: null,
      };
    }

    const sourceTag = input.modelSource ?? "committed";
    const assetRef = `preview:${input.projectId}:r${input.revision}:${sourceTag}:${resolvedView}`;
    const assetPath = path.join(
      os.tmpdir(),
      `atelier-preview-${input.projectId.slice(0, 8)}-r${input.revision}-${sourceTag}-${resolvedView}-${Date.now()}.jpg`,
    );
    const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
    await fs.writeFile(assetPath, Buffer.from(base64, "base64"));

    return {
      success: true,
      imageGenerated: true,
      projectId: input.projectId,
      revision: input.revision,
      view: resolvedView,
      requestedView: input.view,
      width,
      height,
      mediaType: "image/jpeg",
      dataUrl,
      assetPath,
      assetRef,
      camera,
      renderBackend: backend,
      note,
    };
  } catch (error) {
    const err = error as Error & {
      code?: string;
      remediation?: string[];
      env?: Record<string, unknown>;
    };
    if (err.code === "BROWSER_UNAVAILABLE") {
      const detail = previewBrowserUnavailableError();
      return {
        success: false,
        imageGenerated: false,
        error: err.message || detail.error,
        code: "BROWSER_UNAVAILABLE",
        projectId: input.projectId,
        revision: input.revision,
        requestedView: input.view,
        renderBackend: null,
        remediation: err.remediation ?? detail.remediation,
        diagnostics: err.env ?? detail.env,
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    const missingBrowser =
      /Executable doesn't exist|browserType\.launch|Failed to launch/i.test(
        message,
      );
    if (missingBrowser) {
      const detail = previewBrowserUnavailableError();
      return {
        success: false,
        imageGenerated: false,
        error: message,
        code: "BROWSER_UNAVAILABLE",
        projectId: input.projectId,
        revision: input.revision,
        requestedView: input.view,
        renderBackend: null,
        remediation: detail.remediation,
        diagnostics: detail.env,
      };
    }

    return {
      success: false,
      imageGenerated: false,
      error: message,
      code: "RENDER_FAILED",
      projectId: input.projectId,
      revision: input.revision,
      requestedView: input.view,
      renderBackend: null,
    };
  } finally {
    if (browserContext) {
      await browserContext.close().catch(() => undefined);
    } else if (page && !page.isClosed()) {
      await page.close().catch(() => undefined);
    }
  }
}
