import { z } from 'zod';

/**
 * Extensible architectural entity types.
 * Known types are listed; unknown strings remain valid for forward compatibility.
 */
export const KnownEntityTypeSchema = z.enum([
  'level',
  'space',
  'exteriorWall',
  'interiorWall',
  'floorSlab',
  'roofAssembly',
  'roofPlane',
  'ridge',
  'hip',
  'valley',
  'gable',
  'eave',
  'dormer',
  'window',
  'exteriorDoor',
  'garageDoor',
  'opening',
  'porch',
  'deck',
  'column',
  'beam',
  'stair',
  'floorOpening',
  'trim',
  'material',
  'shell',
  // Interior / FF&E — agent creates via general tools, not style presets
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
]);
export type KnownEntityType = z.infer<typeof KnownEntityTypeSchema>;

export const EntityTypeSchema = z.union([KnownEntityTypeSchema, z.string().min(1)]);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const DesignEntitySchema = z.object({
  id: z.string().min(1),
  type: EntityTypeSchema,
  parentId: z.string().min(1).optional(),
  levelId: z.string().min(1).optional(),
  /** Geometric descriptors (feet). Shape depends on type. */
  geometry: z.record(z.unknown()).default({}),
  /** Non-geometry architectural properties. */
  properties: z.record(z.unknown()).default({}),
  materialId: z.string().min(1).optional(),
  meta: z.record(z.unknown()).optional(),
});
export type DesignEntity = z.infer<typeof DesignEntitySchema>;

export function isKnownEntityType(type: string): type is KnownEntityType {
  return KnownEntityTypeSchema.safeParse(type).success;
}

export function openingEntityType(
  kind: 'window' | 'door' | 'garageDoor' | 'opening' | string,
): EntityType {
  if (kind === 'window') return 'window';
  if (kind === 'door') return 'exteriorDoor';
  if (kind === 'garageDoor') return 'garageDoor';
  return 'opening';
}
