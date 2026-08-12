import { z } from 'zod';

const Vec2Schema = z.object({
  x: z.number(),
  y: z.number(),
});

/** Axis-aligned rectangular footprint in plan (x = width, y = depth / world Z). */
export const LevelFootprintRectSchema = z.object({
  kind: z.literal('rect').default('rect'),
  /** Plan center. */
  center: Vec2Schema,
  width: z.number().positive(),
  depth: z.number().positive(),
});
export type LevelFootprintRect = z.infer<typeof LevelFootprintRectSchema>;
