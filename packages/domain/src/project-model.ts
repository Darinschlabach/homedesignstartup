import { z } from 'zod';

/**
 * Project Design Model extensions — preferences, history, and agent-facing queries.
 * BuildingModelV1 remains the persisted document; this module adds structured accessors.
 */

export const DesignPreferenceSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.record(z.unknown())]),
  source: z.enum(['user', 'ai', 'system']).default('user'),
  notes: z.string().optional(),
});
export type DesignPreference = z.infer<typeof DesignPreferenceSchema>;

export const DesignHistoryEntrySchema = z.object({
  id: z.string().min(1),
  at: z.string().min(1),
  transactionId: z.string().optional(),
  reason: z.string().optional(),
  summary: z.string().optional(),
  operationCount: z.number().int().nonnegative().optional(),
});
export type DesignHistoryEntry = z.infer<typeof DesignHistoryEntrySchema>;

/** Interior / FF&E object types the agent may create via general tools. */
export const INTERIOR_OBJECT_TYPES = [
  'baseCabinet',
  'wallCabinet',
  'tallCabinet',
  'cabinet',
  'panel',
  'shelf',
  'cabinetDoor',
  'drawer',
  'countertop',
  'backsplash',
  'appliance',
  'sink',
  'faucet',
  'light',
  'furniture',
  'island',
] as const;

export type InteriorObjectType = (typeof INTERIOR_OBJECT_TYPES)[number];

export function isInteriorObjectType(type: string): type is InteriorObjectType {
  return (INTERIOR_OBJECT_TYPES as readonly string[]).includes(type);
}

export const ObjectTransformSchema = z.object({
  /** Plan X (feet), building-centered. */
  x: z.number().default(0),
  /** Elevation Y (feet). */
  y: z.number().default(0),
  /** Plan Z (feet), building-centered. */
  z: z.number().default(0),
  width: z.number().positive().default(2),
  depth: z.number().positive().default(2),
  height: z.number().positive().default(3),
  rotationY: z.number().default(0),
});
export type ObjectTransform = z.infer<typeof ObjectTransformSchema>;
