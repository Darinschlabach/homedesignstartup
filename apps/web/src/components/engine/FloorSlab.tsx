'use client';

import { useMemo, useState } from 'react';
import * as THREE from 'three';
import type { SlabGeom } from '@aihd/domain';
import { ARCH_MATERIALS } from './materials';

function buildSlabGeometry(slab: SlabGeom): THREE.BufferGeometry {
  if (!slab.polygon || slab.polygon.length < 3 || !slab.holes?.length) {
    return new THREE.BoxGeometry(slab.width, slab.thickness, slab.depth);
  }

  const cx = slab.position[0];
  const cz = slab.position[2];
  const shape = new THREE.Shape();
  const first = slab.polygon[0]!;
  shape.moveTo(first.x - cx, first.z - cz);
  for (let i = 1; i < slab.polygon.length; i++) {
    const p = slab.polygon[i]!;
    shape.lineTo(p.x - cx, p.z - cz);
  }
  shape.closePath();

  for (const hole of slab.holes) {
    if (hole.length < 3) continue;
    const path = new THREE.Path();
    // Opposite winding from outer shape so ExtrudeGeometry punches the hole.
    const ordered = [...hole].reverse();
    const h0 = ordered[0]!;
    path.moveTo(h0.x - cx, h0.z - cz);
    for (let i = 1; i < ordered.length; i++) {
      const p = ordered[i]!;
      path.lineTo(p.x - cx, p.z - cz);
    }
    path.closePath();
    shape.holes.push(path);
  }

  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: slab.thickness,
    bevelEnabled: false,
  });
  // Shape is in XZ (as XY); extrude along +Z then rotate so depth → world Y.
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, -slab.thickness / 2, 0);
  return geom;
}

export function FloorSlab({
  slab,
  selected,
  onSelect,
}: {
  slab: SlabGeom;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const highlight = selected || hovered;
  const geometry = useMemo(() => buildSlabGeometry(slab), [slab]);

  return (
    <mesh
      position={slab.position}
      geometry={geometry}
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
      <meshStandardMaterial
        color={highlight ? '#2f5d50' : slab.color || ARCH_MATERIALS.slab.color}
        roughness={slab.roughness ?? ARCH_MATERIALS.slab.roughness}
        metalness={slab.metalness ?? ARCH_MATERIALS.slab.metalness}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}
