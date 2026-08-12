/**
 * Live parametric 3D engine modules.
 * Design data (@aihd/domain shell + buildBuildingGeometry) is the source of truth.
 */
export { BuildingModel } from './BuildingModel';
export { FloorSlab } from './FloorSlab';
export { Wall } from './Wall';
export { Roof } from './Roof';
export { Opening, WindowOpening, ExteriorDoor, GarageDoor } from './Opening';
export { StairMesh } from './Stair';
export { ViewportControls } from './ViewportControls';
export { CameraRig } from './camera-state';
export type { CameraSnapshot, CameraControllerApi, ViewPreset } from './camera-state';
export { ARCH_MATERIALS } from './materials';
/* DevBuildingPanel is intentionally not re-exported — import directly to remove later */
