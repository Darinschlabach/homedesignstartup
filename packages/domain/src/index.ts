export * from './building-model';
export * from './mutations';
export * from './factories';
export * from './barn-shop';
export * from './summary';
export * from './construction';
export * from './checksum';
export * from './shell';
export * from './opening-helpers';
export * from './entities';
export * from './entity-index';
export * from './hydrate-entities';
export * from './roof-entities';
export * from './roof-entities-from-assembly';
export * from './roof-assembly';
export * from './roof-mass-ops';
export * from './levels';
export * from './level-ops';
export * from './level-footprint-schema';
export * from './level-footprint';
export * from './level-footprint-ops';
export * from './lower-roof';
export * from './stair';
export * from './stair-ops';
export {
  buildCrossGableAssembly,
  buildCrossGableAssemblyClipped,
  recompileRoofAssembly,
  RoofIntersectionError,
  assertNoInterpenetration,
  roofHeightAt,
  massPlanBounds,
  clipPlaneByUpperEnvelope,
  deriveIntersectionEdges,
  analyzeCrossGableBreakthrough,
} from './geometry/roof-intersection';
export {
  planeFromPoints,
  planeFromPolygon,
  intersectPlanes,
  clipPolygonByHalfSpace,
  polygonArea3,
  pointInPolygonXZ,
} from './geometry/roof-plane-math';
export * from './operations';
export * from './design-service';
export * from './integrity';
export * from './validation';
export * from './project-model';
export * from './project-queries';
export * from './material-capabilities';
export * from './adapters/floor-plan';
export * from './adapters/scene3d';
export * from './geometry/roof-geometry';
export * from './geometry/building-geometry';
export {
  deriveStairGeometry,
  floorOpeningForStair,
  StairGeometryError,
  STAIR_DEFAULTS,
} from './geometry/stair-geometry';
export type {
  DerivedStairGeometry,
  StairFlightDef,
  StairLandingDef,
} from './geometry/stair-geometry';
