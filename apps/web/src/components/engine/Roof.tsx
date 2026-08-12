'use client';

import { useLayoutEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import type { RoofSurface } from '@aihd/domain';
import { ARCH_MATERIALS } from './materials';

function RoofSurfaceMesh({
  surface,
  selected,
  hovered,
  onSelect,
  onHover,
}: {
  surface: RoofSurface;
  selected?: boolean;
  hovered?: boolean;
  onSelect?: () => void;
  onHover?: (hover: boolean) => void;
}) {
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(surface.positions);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    return geo;
  }, [surface.positions]);

  useLayoutEffect(() => {
    return () => {
      geometry.dispose();
    };
  }, [geometry]);

  if (surface.positions.length < 9) return null;

  const highlight = selected || hovered;

  return (
    <mesh
      geometry={geometry}
      castShadow
      receiveShadow
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.();
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover?.(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        onHover?.(false);
        document.body.style.cursor = 'auto';
      }}
    >
      <meshStandardMaterial
        color={highlight ? '#2f5d50' : surface.color || ARCH_MATERIALS.roof.color}
        roughness={surface.roughness ?? ARCH_MATERIALS.roof.roughness}
        metalness={surface.metalness ?? ARCH_MATERIALS.roof.metalness}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

export function Roof({
  surfaces,
  selectedId,
  onSelect,
}: {
  surfaces: RoofSurface[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <group name="roof">
      {surfaces.map((surface) => (
        <RoofSurfaceMesh
          key={surface.id}
          surface={surface}
          selected={
            selectedId === surface.entityId ||
            selectedId === surface.parentEntityId ||
            selectedId === surface.id
          }
          hovered={hoveredId === surface.entityId}
          onSelect={() => onSelect?.(surface.entityId)}
          onHover={(h) => setHoveredId(h ? surface.entityId : null)}
        />
      ))}
    </group>
  );
}
