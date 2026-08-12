'use client';

import { useMemo } from 'react';
import type { BuildingModelV1 } from '@aihd/domain';
import { buildBuildingGeometry } from '@aihd/domain';
import { FloorSlab } from './FloorSlab';
import { Wall } from './Wall';
import { Roof } from './Roof';
import { Opening } from './Opening';
import { PlacedObject } from './PlacedObject';
import { StairMesh } from './Stair';

/**
 * Procedural building from parametric design data.
 * Design model is the source of truth — this only renders descriptors.
 */
export function BuildingModel({
  model,
  selectedEntityId,
  onSelect,
}: {
  model: BuildingModelV1;
  selectedEntityId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const geom = useMemo(() => buildBuildingGeometry(model), [model]);

  return (
    <group name="building">
      {geom.slabs.map((slab) => (
        <FloorSlab
          key={slab.id}
          slab={slab}
          selected={selectedEntityId === slab.id}
          onSelect={() => onSelect(slab.id)}
        />
      ))}
      {geom.walls.map((wall) => (
        <Wall
          key={wall.id}
          wall={wall}
          selected={selectedEntityId === wall.id}
          onSelect={() => onSelect(wall.id)}
        />
      ))}
      <Roof
        surfaces={geom.roofs}
        selectedId={selectedEntityId}
        onSelect={onSelect}
      />
      {geom.openings.map((opening) => (
        <Opening
          key={opening.id}
          opening={opening}
          selected={selectedEntityId === opening.id}
          onSelect={() => onSelect(opening.id)}
        />
      ))}
      {geom.placedObjects.map((obj) => (
        <PlacedObject
          key={obj.id}
          object={obj}
          selected={selectedEntityId === obj.id}
          onSelect={() => onSelect(obj.id)}
        />
      ))}
      {geom.stairs.map((stair) => (
        <StairMesh
          key={stair.id}
          stair={stair}
          selected={selectedEntityId === stair.id}
          onSelect={() => onSelect(stair.id)}
        />
      ))}
    </group>
  );
}
