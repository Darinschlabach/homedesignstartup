/**
 * Domain ops for custom / setback level footprints.
 * Not agent-facing yet.
 */
import type { BuildingModelV1 } from './building-model';
import {
  applyClearCustomFootprint,
  applyCustomFootprintToLevels,
  applyUpdateCustomFootprint,
  LevelFootprintError,
  reportExposedLowerRoofRegions,
  type SetLevelFootprintInput,
  type UpdateLevelFootprintInput,
} from './level-footprint';
import { extractShellFromModel, syncShellToModel } from './shell';

function requireShell(model: BuildingModelV1) {
  const shell = extractShellFromModel(model);
  if (!shell) {
    throw new LevelFootprintError('NO_SHELL', 'BuildingShell is required');
  }
  return shell;
}

export function setLevelFootprint(
  model: BuildingModelV1,
  input: SetLevelFootprintInput,
): BuildingModelV1 {
  const shell = requireShell(model);
  const next = applyCustomFootprintToLevels(model, input);
  return syncShellToModel(next, shell);
}

export function updateLevelFootprint(
  model: BuildingModelV1,
  input: UpdateLevelFootprintInput,
): BuildingModelV1 {
  const shell = requireShell(model);
  const next = applyUpdateCustomFootprint(model, input);
  return syncShellToModel(next, shell);
}

export function clearLevelFootprint(
  model: BuildingModelV1,
  levelId: string,
): BuildingModelV1 {
  const shell = requireShell(model);
  const next = applyClearCustomFootprint(model, levelId);
  return syncShellToModel(next, shell);
}

export { LevelFootprintError, reportExposedLowerRoofRegions };
export type { SetLevelFootprintInput, UpdateLevelFootprintInput };
