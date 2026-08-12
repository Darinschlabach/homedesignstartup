import type { Material } from './building-model';

/**
 * What BuildingModelV1 MaterialSchema + the live/preview renderers actually honor.
 * Do not invent texture/opacity fields here until domain + renderer support them.
 */
export const MATERIAL_CAPABILITIES = {
  supportedFields: [
    'id',
    'name',
    'category',
    'color',
    'roughness',
    'metalness',
  ] as const,
  unsupportedFields: [
    'opacity',
    'texture',
    'textureReference',
    'normalMap',
    'normalMapReference',
    'textureScale',
    'maps',
    'emissive',
    'aoMap',
  ] as const,
  categories: ['wall', 'roof', 'floor', 'trim', 'structure'] as const,
  notes: [
    'Materials live in BuildingModelV1.materials[] and are referenced by materialId on walls/roofs/slabs/entities.',
    'Live R3F meshes and render_preview honor color, roughness, and metalness from the material catalog.',
    'Textures, normal maps, opacity, and texture scale are NOT in MaterialSchema and are not applied by the renderer.',
    'Opening meshes use hardcoded appearance today and do not take materialId from OpeningSchema.',
  ],
} as const;

export type MaterialCategory = (typeof MATERIAL_CAPABILITIES.categories)[number];

export function materialPublicView(m: Material) {
  return {
    id: m.id,
    name: m.name,
    category: m.category,
    color: m.color,
    finish: {
      roughness: m.roughness,
      metalness: m.metalness,
    },
    texture: null as string | null,
    normalMap: null as string | null,
  };
}

export function generateMaterialId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  const rand = Math.random().toString(36).slice(2, 8);
  return `mat-${slug || 'custom'}-${rand}`;
}
