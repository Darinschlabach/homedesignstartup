'use client';

import { useState } from 'react';
import type { StairGeom } from '@aihd/domain';

export function StairMesh({
  stair,
  selected,
  onSelect,
}: {
  stair: StairGeom;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const highlight = selected || hovered;
  const color = highlight ? '#2f5d50' : stair.color;

  return (
    <group name={stair.id}>
      {stair.derived.risers.map((riser) => (
        <mesh
          key={riser.id}
          position={[riser.position.x, riser.position.y, riser.position.z]}
          rotation={[0, (riser.rotationYDeg * Math.PI) / 180, 0]}
          castShadow
          receiveShadow
          onClick={(e) => {
            e.stopPropagation();
            onSelect?.();
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            setHovered(true);
            document.body.style.cursor = 'pointer';
          }}
          onPointerOut={() => {
            setHovered(false);
            document.body.style.cursor = 'auto';
          }}
        >
          <boxGeometry
            args={[riser.size.width, riser.size.height, riser.size.depth]}
          />
          <meshStandardMaterial
            color={color}
            roughness={stair.roughness ?? 0.85}
            metalness={stair.metalness ?? 0}
          />
        </mesh>
      ))}
      {stair.derived.treads.map((tread) => (
        <mesh
          key={tread.id}
          position={[tread.position.x, tread.position.y, tread.position.z]}
          rotation={[0, (tread.rotationYDeg * Math.PI) / 180, 0]}
          castShadow
          receiveShadow
          onClick={(e) => {
            e.stopPropagation();
            onSelect?.();
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            setHovered(true);
            document.body.style.cursor = 'pointer';
          }}
          onPointerOut={() => {
            setHovered(false);
            document.body.style.cursor = 'auto';
          }}
        >
          <boxGeometry
            args={[tread.size.width, tread.size.height, tread.size.depth]}
          />
          <meshStandardMaterial
            color={color}
            roughness={stair.roughness ?? 0.85}
            metalness={stair.metalness ?? 0}
          />
        </mesh>
      ))}
    </group>
  );
}
