import type { BuildingModelV1, BuildingType, Material } from './building-model';
import { BuildingShellSchema, syncShellToModel } from './shell';

const DEFAULT_MATERIALS: Material[] = [
  {
    id: 'mat-wall',
    name: 'Exterior Wall',
    category: 'wall',
    color: '#D9D2C5',
    roughness: 0.88,
    metalness: 0,
  },
  {
    id: 'mat-roof',
    name: 'Roof',
    category: 'roof',
    color: '#4A5560',
    roughness: 0.5,
    metalness: 0.25,
  },
  {
    id: 'mat-floor',
    name: 'Slab',
    category: 'floor',
    color: '#A8A29A',
    roughness: 0.92,
    metalness: 0,
  },
  {
    id: 'mat-structure',
    name: 'Timber',
    category: 'structure',
    color: '#8B6914',
    roughness: 0.75,
    metalness: 0,
  },
  {
    id: 'mat-trim',
    name: 'Trim',
    category: 'trim',
    color: '#F5F0E6',
    roughness: 0.7,
    metalness: 0,
  },
];

export function createEmptyBuildingModel(
  buildingType: BuildingType = 'home',
  name = 'Untitled Project',
): BuildingModelV1 {
  const levelHeight = buildingType === 'home' ? 9 : 14;
  return {
    meta: {
      version: 1,
      name,
      buildingType,
      units: 'imperial',
      stories: 1,
    },
    levels: [
      {
        id: 'level-1',
        name: buildingType === 'home' ? 'Main Floor' : 'Ground',
        elevation: 0,
        height: levelHeight,
        footprintSource: 'shell',
      },
    ],
    spaces: [],
    walls: [],
    openings: [],
    roofs: [],
    roofAssemblies: [],
    slabs: [],
    stairs: [],
    floorOpenings: [],
    structure: [],
    materials: DEFAULT_MATERIALS,
    constraints: [],
    entities: [],
    protectedEntityIds: [],
    designPreferences: [],
    designHistory: [],
  };
}

/** Simple rectangular footprint driven by parametric shell. */
export function createRectangularShell(options: {
  buildingType: BuildingType;
  name?: string;
  width: number;
  depth: number;
  wallHeight?: number;
  wallThickness?: number;
}): BuildingModelV1 {
  const {
    buildingType,
    name = 'New Building',
    width,
    depth,
    wallHeight = buildingType === 'home' ? 9 : 14,
    wallThickness = 0.5,
  } = options;

  const model = createEmptyBuildingModel(buildingType, name);
  const shell = BuildingShellSchema.parse({
    width,
    depth,
    wallHeight,
    wallThickness,
    roof: {
      type: 'gable',
      pitch: buildingType === 'home' ? 6 : 4,
      overhang: 1.5,
      ridgeDirection: 'depth',
    },
    openings: [
      {
        id: 'door-1',
        type: buildingType === 'home' ? 'door' : 'garageDoor',
        wall: 'front',
        offset: width / 2 - (buildingType === 'home' ? 1.5 : 5),
        width: buildingType === 'home' ? 3 : 10,
        height: buildingType === 'home' ? 7 : 12,
        sillHeight: 0,
      },
    ],
  });

  return syncShellToModel(model, shell);
}
