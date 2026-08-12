import type { BuildingModelV1, BuildingType, StructureMember } from './building-model';
import { createRectangularShell } from './factories';

export interface BayLayoutOptions {
  buildingType: Extract<BuildingType, 'barn' | 'shop'>;
  name?: string;
  width: number;
  depth: number;
  bayCount: number;
  eaveHeight?: number;
  postSection?: number;
}

/**
 * Creates a post-frame barn/shop with evenly spaced bays along the length.
 */
export function createBayBuilding(options: BayLayoutOptions): BuildingModelV1 {
  const {
    buildingType,
    name = buildingType === 'barn' ? 'Post-Frame Barn' : 'Shop',
    width,
    depth,
    bayCount,
    eaveHeight = 14,
    postSection = 0.5,
  } = options;

  const bays = Math.max(1, Math.floor(bayCount));
  const shell = createRectangularShell({
    buildingType,
    name,
    width,
    depth,
    wallHeight: eaveHeight,
  });

  const levelId = shell.levels[0]!.id;
  const hw = width / 2;
  const hd = depth / 2;
  const structure: StructureMember[] = [];

  for (let i = 0; i <= bays; i++) {
    const y = -hd + (depth * i) / bays;
    for (const x of [-hw, hw]) {
      structure.push({
        id: `post-${i}-${x < 0 ? 'L' : 'R'}`,
        kind: 'post',
        levelId,
        start: { x, y: 0, z: y },
        end: { x, y: eaveHeight, z: y },
        sectionWidth: postSection,
        sectionDepth: postSection,
        label: `Bay ${i}`,
      });
    }
    structure.push({
      id: `beam-${i}`,
      kind: 'beam',
      levelId,
      start: { x: -hw, y: eaveHeight, z: y },
      end: { x: hw, y: eaveHeight, z: y },
      sectionWidth: postSection,
      sectionDepth: postSection * 1.2,
      label: `Bay ${i} beam`,
    });
  }

  return {
    ...shell,
    structure,
    constraints: [
      {
        id: 'c-bays',
        text: `${bays} bay ${buildingType}, ${width}x${depth}, ${eaveHeight}' eave`,
        priority: 'must',
        source: 'system',
      },
    ],
  };
}
