/** Shared camera pose math for live viewport presets and agent preview renders. */

export interface CameraSnapshot {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  fov: number;
}

export type ViewPreset =
  | "perspective"
  | "front"
  | "rear"
  | "left"
  | "right"
  | "top";

/** Agent-facing view names (includes aliases + room/current). */
export type PreviewView =
  | ViewPreset
  | "isometric"
  | "current"
  | "room";

function defaultDistance(extent: number) {
  return Math.max(40, extent * 1.35);
}

/**
 * Same positioning used by the live R3F CameraRig presets.
 */
export function computeCameraPose(
  preset: ViewPreset,
  buildingExtent = 60,
  fov = 45,
): CameraSnapshot {
  const d = defaultDistance(buildingExtent);
  const lookAtHeight = 4;
  const target = { x: 0, y: lookAtHeight, z: 0 };
  let position: { x: number; y: number; z: number };

  switch (preset) {
    case "front":
      position = { x: 0, y: lookAtHeight + buildingExtent * 0.15, z: -d };
      break;
    case "rear":
      position = { x: 0, y: lookAtHeight + buildingExtent * 0.15, z: d };
      break;
    case "left":
      position = { x: -d, y: lookAtHeight + buildingExtent * 0.15, z: 0 };
      break;
    case "right":
      position = { x: d, y: lookAtHeight + buildingExtent * 0.15, z: 0 };
      break;
    case "top":
      position = { x: 0.01, y: d * 1.2, z: 0.01 };
      break;
    case "perspective":
    default:
      position = { x: d * 0.75, y: d * 0.55, z: d * 0.75 };
      break;
  }

  return { position, target, fov };
}

export function resolvePreviewCamera(options: {
  view: PreviewView;
  buildingExtent: number;
  shell?: { width: number; depth: number; wallHeight: number } | null;
  /** Workspace camera when view === "current". */
  currentCamera?: CameraSnapshot | null;
}): { camera: CameraSnapshot; resolvedView: string; note?: string } {
  const { view, buildingExtent, shell, currentCamera } = options;

  if (view === "current") {
    if (currentCamera?.position && currentCamera?.target) {
      return {
        camera: {
          position: currentCamera.position,
          target: currentCamera.target,
          fov: currentCamera.fov ?? 45,
        },
        resolvedView: "current",
      };
    }
    return {
      camera: computeCameraPose("perspective", buildingExtent),
      resolvedView: "perspective",
      note: "No workspace camera snapshot provided; fell back to perspective.",
    };
  }

  if (view === "isometric") {
    return {
      camera: computeCameraPose("perspective", buildingExtent),
      resolvedView: "isometric",
      note: "Isometric mapped to the shared perspective/corner preset.",
    };
  }

  if (view === "room") {
    const width = shell?.width ?? buildingExtent;
    const depth = shell?.depth ?? buildingExtent;
    const wallHeight = shell?.wallHeight ?? 10;
    // Interior view looking toward the front elevation (negative Z in this model).
    return {
      camera: {
        position: {
          x: 0,
          y: Math.min(wallHeight * 0.55, 8),
          z: Math.max(depth * 0.15, 6),
        },
        target: {
          x: 0,
          y: Math.min(wallHeight * 0.4, 6),
          z: -depth * 0.45,
        },
        fov: 60,
      },
      resolvedView: "room",
      note: `Room/interior preview for footprint ~${width}' x ${depth}'.`,
    };
  }

  return {
    camera: computeCameraPose(view, buildingExtent),
    resolvedView: view,
  };
}
