'use client';

import { useState } from 'react';
import type { OpeningPlacement } from '@aihd/domain';
import { ARCH_MATERIALS } from './materials';

function OpeningMesh({
  opening,
  selected,
  onSelect,
  color,
  roughness,
  metalness,
  opacity,
  transparent,
  depth,
}: {
  opening: OpeningPlacement;
  selected?: boolean;
  onSelect?: () => void;
  color: string;
  roughness: number;
  metalness: number;
  opacity?: number;
  transparent?: boolean;
  depth: number;
}) {
  const [hovered, setHovered] = useState(false);
  const rotY = (opening.rotationY * Math.PI) / 180;
  const highlight = selected || hovered;

  return (
    <mesh
      position={opening.position}
      rotation={[0, rotY, 0]}
      castShadow
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
      <boxGeometry args={[opening.width, opening.height, depth]} />
      <meshStandardMaterial
        color={highlight ? '#2f5d50' : color}
        roughness={roughness}
        metalness={metalness}
        transparent={transparent}
        opacity={opacity}
        depthWrite={!transparent}
      />
    </mesh>
  );
}

export function WindowOpening(props: {
  opening: OpeningPlacement;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const m = ARCH_MATERIALS.windowGlass;
  return (
    <OpeningMesh
      {...props}
      color={m.color}
      roughness={m.roughness}
      metalness={m.metalness}
      transparent={m.transparent}
      opacity={m.opacity}
      depth={0.12}
    />
  );
}

export function ExteriorDoor(props: {
  opening: OpeningPlacement;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const m = ARCH_MATERIALS.door;
  return (
    <OpeningMesh
      {...props}
      color={m.color}
      roughness={m.roughness}
      metalness={m.metalness}
      depth={0.16}
    />
  );
}

export function GarageDoor(props: {
  opening: OpeningPlacement;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const m = ARCH_MATERIALS.garageDoor;
  return (
    <OpeningMesh
      {...props}
      color={m.color}
      roughness={m.roughness}
      metalness={m.metalness}
      depth={0.2}
    />
  );
}

export function Opening({
  opening,
  selected,
  onSelect,
}: {
  opening: OpeningPlacement;
  selected?: boolean;
  onSelect?: () => void;
}) {
  if (opening.type === 'window') {
    return <WindowOpening opening={opening} selected={selected} onSelect={onSelect} />;
  }
  if (opening.type === 'garageDoor') {
    return <GarageDoor opening={opening} selected={selected} onSelect={onSelect} />;
  }
  return <ExteriorDoor opening={opening} selected={selected} onSelect={onSelect} />;
}
