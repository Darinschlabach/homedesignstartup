import type { BuildingModelV1 } from './building-model';

export function checkModelIntegrity(model: BuildingModelV1): string[] {
  const issues: string[] = [];
  const levelIds = new Set(model.levels.map((l) => l.id));
  const wallIds = new Set(model.walls.map((w) => w.id));
  const materialIds = new Set(model.materials.map((m) => m.id));

  if (model.walls.length > 500) issues.push('Too many walls (max 500)');
  if (model.spaces.length > 200) issues.push('Too many spaces (max 200)');

  for (const wall of model.walls) {
    if (!levelIds.has(wall.levelId)) issues.push(`Wall ${wall.id} references missing level`);
    if (wall.start.x === wall.end.x && wall.start.y === wall.end.y) {
      issues.push(`Wall ${wall.id} has zero length`);
    }
    if (wall.materialId && !materialIds.has(wall.materialId)) {
      issues.push(`Wall ${wall.id} references missing material`);
    }
  }

  for (const space of model.spaces) {
    if (!levelIds.has(space.levelId)) issues.push(`Space ${space.id} references missing level`);
  }

  for (const opening of model.openings) {
    if (!wallIds.has(opening.wallId)) {
      issues.push(`Opening ${opening.id} references missing wall`);
    }
  }

  for (const roof of model.roofs) {
    if (!levelIds.has(roof.levelId)) issues.push(`Roof ${roof.id} references missing level`);
  }

  for (const slab of model.slabs) {
    if (!levelIds.has(slab.levelId)) issues.push(`Slab ${slab.id} references missing level`);
  }

  for (const stair of model.stairs ?? []) {
    if (!levelIds.has(stair.fromLevelId)) {
      issues.push(`Stair ${stair.id} references missing fromLevel`);
    }
    if (!levelIds.has(stair.toLevelId)) {
      issues.push(`Stair ${stair.id} references missing toLevel`);
    }
    if (stair.floorOpeningId) {
      const opening = (model.floorOpenings ?? []).find((o) => o.id === stair.floorOpeningId);
      if (!opening) {
        issues.push(`Stair ${stair.id} references missing floor opening`);
      }
    }
  }

  for (const opening of model.floorOpenings ?? []) {
    if (!levelIds.has(opening.levelId)) {
      issues.push(`Floor opening ${opening.id} references missing level`);
    }
    if (opening.stairId && !(model.stairs ?? []).some((s) => s.id === opening.stairId)) {
      issues.push(`Floor opening ${opening.id} references missing stair`);
    }
  }

  for (const assembly of model.roofAssemblies ?? []) {
    if (!levelIds.has(assembly.levelId)) {
      issues.push(`Roof assembly ${assembly.id} references missing level`);
    }
  }

  for (const member of model.structure) {
    if (!levelIds.has(member.levelId)) {
      issues.push(`Structure ${member.id} references missing level`);
    }
  }

  for (const e of model.entities ?? []) {
    if (e.levelId && !levelIds.has(e.levelId) && e.type !== 'level') {
      issues.push(`Entity ${e.id} references missing level`);
    }
  }

  return issues;
}
