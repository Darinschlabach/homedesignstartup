'use client';

import { useState } from 'react';
import type { PlacedObjectGeom } from '@aihd/domain';

export function PlacedObject({
  object,
  selected,
  onSelect,
}: {
  object: PlacedObjectGeom;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const highlight = selected || hovered;
  const rotY = (object.rotationY * Math.PI) / 180;

  return (
    <mesh
      position={object.position}
      rotation={[0, rotY, 0]}
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
      <boxGeometry args={object.size} />
      <meshStandardMaterial
        color={highlight ? '#2f5d50' : object.color}
        roughness={0.75}
        metalness={0.05}
      />
    </mesh>
  );
}
