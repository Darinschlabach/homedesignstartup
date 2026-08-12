import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  applyDesignOperations,
  DesignServiceError,
  detectCollision,
  extractShellFromModel,
  getEntity,
  INTERIOR_OBJECT_TYPES,
  isInteriorObjectType,
  listEntities,
  summarizeEntity,
  type BuildingModelV1,
  type DesignOperation,
  type InteriorObjectType,
} from "@aihd/domain";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import {
  assertLoopNotBlocked,
  guardAgainstIdenticalFailure,
  recordToolFailure,
  recordToolSuccess,
} from "../loopSafety";
import {
  operationMeta,
  stageDesignOperations,
} from "../operation/agentOperation";
import { loadAgentModel } from "../project/loadAgentModel";

/** Shell / opening / structure types that must NOT use create_object. */
const UNSUPPORTED_CREATE_TYPES = new Set([
  "window",
  "exteriorDoor",
  "garageDoor",
  "opening",
  "door",
  "exteriorWall",
  "interiorWall",
  "wall",
  "floorSlab",
  "slab",
  "shell",
  "level",
  "space",
  "roofAssembly",
  "roofPlane",
  "ridge",
  "roof",
]);

const createObjectProperties = z
  .object({
    name: z.string().min(1).optional(),
    /** Free-text subtype within a supported type, e.g. "bench", "refrigerator". */
    subtype: z.string().min(1).optional(),
    /** Alias for subtype preferred by some callers (appliance kind, etc.). */
    kind: z.string().min(1).optional(),
    roomId: z.string().min(1).optional(),
  })
  .strict();

const createObjectParameters = z
  .object({
    type: z
      .enum(INTERIOR_OBJECT_TYPES)
      .describe(
        "Supported placed-object type. Not for windows/doors/walls/roof/footprint — use create_opening for shell openings; wall/roof/footprint tools come later.",
      ),
    subtype: z
      .string()
      .min(1)
      .optional()
      .describe('Optional subtype label, e.g. "bench", "sofa", "pendant".'),
    name: z.string().min(1).optional(),
    parentId: z
      .string()
      .min(1)
      .optional()
      .describe("Optional parent entity or wall id."),
    levelId: z.string().min(1).optional(),
    roomId: z
      .string()
      .min(1)
      .optional()
      .describe("Optional space/room id (stored as properties.roomId)."),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    depth: z.number().positive().optional(),
    x: z.number().optional().describe("Plan X (feet), building-centered."),
    y: z.number().optional().describe("Elevation Y (feet)."),
    z: z.number().optional().describe("Plan Z (feet), building-centered."),
    rotationY: z.number().optional().describe("Yaw in degrees."),
    materialId: z.string().min(1).optional(),
    properties: createObjectProperties.optional(),
  })
  .strict();

type CreateObjectArgs = z.infer<typeof createObjectParameters>;

/** LLM tool calls often send null for omitted optionals — normalize before use. */
function normalizeCreateArgs(raw: CreateObjectArgs): CreateObjectArgs {
  const scrub = <T,>(v: T | null | undefined): T | undefined =>
    v == null ? undefined : v;
  return {
    ...raw,
    subtype: scrub(raw.subtype as string | null | undefined),
    name: scrub(raw.name as string | null | undefined),
    parentId: scrub(raw.parentId as string | null | undefined),
    levelId: scrub(raw.levelId as string | null | undefined),
    roomId: scrub(raw.roomId as string | null | undefined),
    materialId: scrub(raw.materialId as string | null | undefined),
  };
}

function generateObjectId(type: string): string {
  return `obj-${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function resolveLevelId(
  model: BuildingModelV1,
  levelId: string | undefined,
): { ok: true; levelId: string | undefined } | { ok: false; error: string } {
  if (!levelId) {
    return { ok: true, levelId: model.levels[0]?.id };
  }
  if (!model.levels.some((l) => l.id === levelId)) {
    return {
      ok: false,
      error: `levelId "${levelId}" does not exist on this model.`,
    };
  }
  return { ok: true, levelId };
}

function resolveParent(
  model: BuildingModelV1,
  parentId: string | undefined,
): { ok: true } | { ok: false; error: string; code: string } {
  if (!parentId) return { ok: true };
  const entity = getEntity(model, parentId);
  const wall = model.walls.find((w) => w.id === parentId);
  if (!entity && !wall) {
    return {
      ok: false,
      error: `parentId "${parentId}" was not found in entities or walls.`,
      code: "INVALID_PARENT",
    };
  }
  const protectedIds = new Set(model.protectedEntityIds ?? []);
  if (protectedIds.has(parentId)) {
    return {
      ok: false,
      error: `Cannot parent a new object to protected target "${parentId}".`,
      code: "PROTECTED_PARENT",
    };
  }
  return { ok: true };
}

function resolveRoom(
  model: BuildingModelV1,
  roomId: string | undefined,
): { ok: true } | { ok: false; error: string } {
  if (!roomId) return { ok: true };
  const inSpaces = model.spaces.some((s) => s.id === roomId);
  const spaceEntity = getEntity(model, roomId);
  if (!inSpaces && spaceEntity?.type !== "space") {
    return {
      ok: false,
      error: `roomId "${roomId}" does not match a space/room on this model.`,
    };
  }
  return { ok: true };
}

function dimensionIssues(
  model: BuildingModelV1,
  args: CreateObjectArgs,
): string | null {
  const shell = extractShellFromModel(model);
  const dims = [args.width, args.height, args.depth].filter(
    (n): n is number => typeof n === "number",
  );
  for (const n of dims) {
    if (!(n > 0) || !Number.isFinite(n)) {
      return "Dimensions must be finite and positive.";
    }
  }
  if (!shell) return null;
  const maxSpan = Math.max(shell.width, shell.depth, shell.wallHeight) * 2;
  const hardCap = Math.max(maxSpan, 40);
  for (const [label, n] of [
    ["width", args.width],
    ["height", args.height],
    ["depth", args.depth],
  ] as const) {
    if (n != null && n > hardCap) {
      return `${label} ${n}ft exceeds allowed maximum ${hardCap}ft for this building.`;
    }
  }
  if (args.height != null && args.height > shell.wallHeight + 5) {
    return `height ${args.height}ft is unrealistically taller than wall height ${shell.wallHeight}ft.`;
  }
  return null;
}

function placementIssues(
  model: BuildingModelV1,
  args: CreateObjectArgs,
): string | null {
  const shell = extractShellFromModel(model);
  if (!shell) return null;
  if (args.x == null && args.z == null && args.y == null) return null;
  const x = args.x ?? 0;
  const z = args.z ?? 0;
  // Allow exterior placement near the shell; reject only far-away absurd placements.
  const margin = Math.max(shell.width, shell.depth) + 20;
  if (Math.abs(x) > margin || Math.abs(z) > margin) {
    return `Placement (${x}, ${z}) is too far from the building footprint for a safe create.`;
  }
  if (args.y != null && (args.y < -1 || args.y > shell.wallHeight + 10)) {
    return `Elevation y=${args.y} is outside a reasonable range for this building.`;
  }
  return null;
}

function findCollisions(
  model: BuildingModelV1,
  objectId: string,
): Array<{ a: string; b: string }> {
  const collisions: Array<{ a: string; b: string }> = [];
  for (const other of listEntities(model)) {
    if (other.id === objectId) continue;
    if (!isInteriorObjectType(String(other.type))) continue;
    const result = detectCollision(model, objectId, other.id);
    if (result.colliding) collisions.push({ a: objectId, b: other.id });
  }
  return collisions;
}

function buildProperties(args: CreateObjectArgs): Record<string, unknown> {
  const props: Record<string, unknown> = {
    ...(args.properties ?? {}),
  };
  if (args.name) props.name = args.name;
  if (args.subtype) props.subtype = args.subtype;
  if (args.properties?.kind && !props.subtype) {
    props.subtype = args.properties.kind;
  }
  if (args.properties?.subtype) props.subtype = args.properties.subtype;
  if (args.roomId) props.roomId = args.roomId;
  if (args.properties?.roomId) props.roomId = args.properties.roomId;
  if (args.properties?.kind) props.kind = args.properties.kind;
  return props;
}

export const createObjectTool = tool({
  name: "create_object",

  description:
    "Stage a NEW supported placed object (furniture, cabinets, appliances, lights, etc.) into the current agent operation working model. IDs are generated server-side. Does NOT create windows/doors/walls/roof/footprint — use create_opening for shell openings. Does NOT commit a revision by itself.",

  parameters: createObjectParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args = normalizeCreateArgs(rawArgs as CreateObjectArgs);

    homeDesignAgentDevLog("create_object_execute_start", {
      tool: "create_object",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "create_object", args, {
        validationFailure:
          code === "VALIDATION_FAILED" ||
          code === "UNSUPPORTED_TYPE" ||
          code === "INVALID_PARENT" ||
          code === "INVALID_LEVEL" ||
          code === "INVALID_ROOM" ||
          code === "INVALID_DIMENSIONS" ||
          code === "INVALID_PLACEMENT" ||
          code === "COLLISION" ||
          code === "MATERIAL_NOT_FOUND" ||
          code === "PROTECTED_PARENT",
      });
      homeDesignAgentDevLog("create_object_execute_end", {
        tool: "create_object",
        arguments: args,
        ok: false,
        ...payload,
      });
      return { success: false as const, ...payload };
    };

    try {
      const blocked = assertLoopNotBlocked(context?.loopSafety);
      if (blocked) return fail(blocked);

      const identical = context?.loopSafety
        ? guardAgainstIdenticalFailure(context.loopSafety, "create_object", args)
        : null;
      if (identical) return fail(identical);

      if (!context?.operation) {
        return fail({
          error: "Agent operation is not initialized.",
          code: "NO_OPERATION",
        });
      }

      const loaded = await loadAgentModel(context);
      if (!loaded.success) return fail(loaded);

      const type = args.type as InteriorObjectType;
      if (!isInteriorObjectType(type) || UNSUPPORTED_CREATE_TYPES.has(type)) {
        return fail({
          error: `Unsupported create_object type "${type}". Supported: ${INTERIOR_OBJECT_TYPES.join(", ")}. Windows/doors/walls/roof/footprint require specialized tools.`,
          code: "UNSUPPORTED_TYPE",
          supportedTypes: INTERIOR_OBJECT_TYPES,
        });
      }

      const dimError = dimensionIssues(loaded.model, args);
      if (dimError) {
        return fail({
          error: dimError,
          code: "INVALID_DIMENSIONS",
        });
      }

      const placeError = placementIssues(loaded.model, args);
      if (placeError) {
        return fail({
          error: placeError,
          code: "INVALID_PLACEMENT",
        });
      }

      const level = resolveLevelId(loaded.model, args.levelId);
      if (!level.ok) {
        return fail({ error: level.error, code: "INVALID_LEVEL" });
      }

      const parent = resolveParent(loaded.model, args.parentId);
      if (!parent.ok) {
        return fail({ error: parent.error, code: parent.code });
      }

      const room = resolveRoom(
        loaded.model,
        args.roomId ?? args.properties?.roomId,
      );
      if (!room.ok) {
        return fail({ error: room.error, code: "INVALID_ROOM" });
      }

      if (args.materialId) {
        const mat = loaded.model.materials.find((m) => m.id === args.materialId);
        if (!mat) {
          return fail({
            error: `materialId "${args.materialId}" was not found in the material catalog.`,
            code: "MATERIAL_NOT_FOUND",
            materialId: args.materialId,
          });
        }
      }

      const objectId = generateObjectId(type);
      if (getEntity(loaded.model, objectId)) {
        return fail({
          error: `Generated object id already exists: ${objectId}`,
          code: "ID_COLLISION",
          objectId,
        });
      }

      const properties = buildProperties(args);
      const operation: DesignOperation = {
        op: "createObject",
        object: {
          id: objectId,
          type,
          ...(args.parentId ? { parentId: args.parentId } : {}),
          ...(level.levelId ? { levelId: level.levelId } : {}),
          ...(args.x != null ? { x: args.x } : {}),
          ...(args.y != null ? { y: args.y } : {}),
          ...(args.z != null ? { z: args.z } : {}),
          ...(args.width != null ? { width: args.width } : {}),
          ...(args.height != null ? { height: args.height } : {}),
          ...(args.depth != null ? { depth: args.depth } : {}),
          ...(args.rotationY != null ? { rotationY: args.rotationY } : {}),
          ...(args.materialId ? { materialId: args.materialId } : {}),
          ...(Object.keys(properties).length > 0 ? { properties } : {}),
        },
      };

      // Dry-run apply for schema/parent validation + collision detection before staging.
      let prospective: BuildingModelV1;
      try {
        prospective = applyDesignOperations(loaded.model, [operation]);
      } catch (error) {
        if (error instanceof DesignServiceError) {
          return fail({
            error: error.message,
            code: "VALIDATION_FAILED",
            validation: { ok: false, issues: error.issues },
            operation: operationMeta(context),
          });
        }
        throw error;
      }

      const createdPreview = getEntity(prospective, objectId);
      if (!createdPreview) {
        return fail({
          error: "Object missing after dry-run createObject.",
          code: "CREATE_FAILED",
          objectId,
        });
      }

      const collisions = findCollisions(prospective, objectId);
      if (collisions.length > 0) {
        return fail({
          error: `Object would collide with existing placed object(s): ${collisions
            .map((c) => c.b)
            .join(", ")}. Adjust placement or size.`,
          code: "COLLISION",
          collisions,
          attempted: summarizeEntity(createdPreview),
          operation: operationMeta(context),
        });
      }

      const staged = await stageDesignOperations(
        context,
        [operation],
        `Stage create_object ${type} ${objectId}`,
      );

      if (!staged.success) {
        return fail({
          error: staged.error,
          code: staged.code,
          validation: staged.validation,
          operation: operationMeta(context),
        });
      }

      const created = getEntity(staged.afterModel, objectId);
      if (!created) {
        return fail({
          error: "Object missing after staging createObject.",
          code: "CREATE_FAILED",
          objectId,
        });
      }

      recordToolSuccess(context.loopSafety);

      const result = {
        success: true as const,
        staged: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        object: summarizeEntity(created),
        objectId: created.id,
        type: created.type,
        materialId: created.materialId ?? null,
        geometry: created.geometry,
        properties: created.properties,
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        supportedTypes: INTERIOR_OBJECT_TYPES,
        operation: operationMeta(context),
        nextStep:
          "Object is staged only. Use inspect_object / get_measurements / render_preview, refine with modify_object or apply_material if needed. Runtime commits once at the end.",
      };

      homeDesignAgentDevLog("create_object_execute_end", {
        tool: "create_object",
        arguments: { ...args, id: objectId },
        ok: true,
        objectId: created.id,
        type: created.type,
        baseRevision: staged.baseRevision,
        staged: true,
        geometry: created.geometry,
        materialId: created.materialId ?? null,
        operation: result.operation,
      });

      return result;
    } catch (error) {
      if (error instanceof DesignServiceError) {
        return fail({
          error: error.message,
          code: "VALIDATION_FAILED",
          validation: {
            ok: false,
            issues: error.issues ?? [],
          },
          projectId: context?.projectId,
        });
      }
      return fail({
        error: error instanceof Error ? error.message : "create_object failed",
        code: "CREATE_OBJECT_FAILED",
        projectId: context?.projectId,
      });
    }
  },
});
