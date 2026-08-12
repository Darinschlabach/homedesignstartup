import { z } from 'zod';

const Vec2Schema = z.object({
  x: z.number(),
  y: z.number(),
});

/**
 * Architectural stair authoring (intent).
 * Derived tread/riser meshes live in geometry/stair-geometry.ts — not authored here.
 *
 * Plan axes: x = width, y = depth (maps to world Z).
 * Vertical: finished floor elevations from Level.elevation.
 */
export const StairTypeSchema = z.enum(['straight', 'lShape']);
export type StairType = z.infer<typeof StairTypeSchema>;

export const StairTurnSchema = z.enum(['left', 'right']);
export type StairTurn = z.infer<typeof StairTurnSchema>;

/**
 * Plan run direction in degrees from +X toward +Y (CCW).
 * 0 = +X (right), 90 = +Y (rear / +world Z).
 */
export const StairSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  type: StairTypeSchema.default('straight'),
  fromLevelId: z.string().min(1),
  toLevelId: z.string().min(1),
  /** Plan origin of the first riser (bottom of stair), feet. */
  origin: Vec2Schema,
  /** Run direction degrees from +X toward +Y (CCW). */
  directionDeg: z.number().default(0),
  /** Clear width between stringers / handrails, feet. */
  width: z.number().positive(),
  /**
   * Optional preferred tread depth (feet). Default ≈ 11" (0.9167).
   * Engine may adjust slightly when fitting an available run.
   */
  targetTreadDepth: z.number().positive().optional(),
  /**
   * Optional maximum riser height (feet). Default ≈ 7.75" (0.6458).
   * Actual riser = totalRise / riserCount ≤ this.
   */
  maxRiserHeight: z.number().positive().optional(),
  /**
   * Horizontal run available for a straight flight (feet), excluding landings.
   * When set, tread depth is derived to fit; otherwise targetTreadDepth is used.
   */
  availableRun: z.number().positive().optional(),
  /** L-shaped: turn direction after the first flight / landing. */
  turn: StairTurnSchema.optional(),
  /**
   * L-shaped: risers on the first flight. Remaining go on the second.
   * When omitted, risers are split as evenly as possible.
   */
  firstFlightRisers: z.number().int().positive().optional(),
  /** Landing edge length (feet). Defaults to stair width (square landing). */
  landingSize: z.number().positive().optional(),
  materialId: z.string().min(1).optional(),
  /** Linked floor opening on the upper slab (managed by stair ops). */
  floorOpeningId: z.string().min(1).optional(),
});
export type Stair = z.infer<typeof StairSchema>;

/**
 * Durable hole in a floor/slab (architectural SoT — not a Three.js-only cut).
 * Typically owned by a stair via stairId.
 */
export const FloorOpeningSchema = z.object({
  id: z.string().min(1),
  levelId: z.string().min(1),
  /** Host slab; when omitted, ops resolve the slab for levelId. */
  slabId: z.string().min(1).optional(),
  /** Plan polygon of the hole (CCW), feet. x = width, y = depth. */
  polygon: z.array(Vec2Schema).min(3),
  /** Owning stair when this opening was generated for vertical circulation. */
  stairId: z.string().min(1).optional(),
  label: z.string().optional(),
});
export type FloorOpening = z.infer<typeof FloorOpeningSchema>;
