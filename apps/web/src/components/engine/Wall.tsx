'use client';

import { useState } from 'react';
import type { WallSegmentGeom } from '@aihd/domain';
import { ARCH_MATERIALS } from './materials';

export function Wall({
  wall,
  selected,
  onSelect,
}: {
  wall: WallSegmentGeom;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const rotY = (wall.rotationY * Math.PI) / 180;
  const highlight = selected || hovered;

  return (
    <mesh
      position={wall.position}
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
      <boxGeometry args={[wall.width, wall.height, wall.thickness]} />
      <meshStandardMaterial
        color={highlight ? '#2f5d50' : wall.color || ARCH_MATERIALS.wall.color}
        roughness={wall.roughness ?? ARCH_MATERIALS.wall.roughness}
        metalness={wall.metalness ?? ARCH_MATERIALS.wall.metalness}
      />
    </mesh>
  );
}
