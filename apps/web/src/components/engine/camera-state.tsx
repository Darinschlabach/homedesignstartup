'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import {
  computeCameraPose,
  type CameraSnapshot,
  type ViewPreset,
} from '@/lib/render/cameraPose';

export type { CameraSnapshot, ViewPreset };

export interface CameraControllerApi {
  getSnapshot: () => CameraSnapshot;
  setPreset: (preset: ViewPreset, buildingExtent?: number) => void;
  reset: (buildingExtent?: number) => void;
}

/**
 * Registers camera control API on a mutable ref (safe across R3F Canvas boundary).
 */
export function CameraRig({
  apiRef,
  controlsRef,
  buildingExtent = 60,
}: {
  apiRef: MutableRefObject<CameraControllerApi | null>;
  controlsRef: MutableRefObject<{ target: THREE.Vector3; update: () => void } | null>;
  buildingExtent?: number;
}) {
  const { camera } = useThree();
  const targetRef = useRef(new THREE.Vector3(0, 4, 0));

  useFrame(() => {
    const controls = controlsRef.current;
    if (controls) {
      targetRef.current.copy(controls.target);
    }
  });

  apiRef.current = {
    getSnapshot: () => {
      const fov = 'fov' in camera && typeof camera.fov === 'number' ? camera.fov : 45;
      return {
        position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        target: {
          x: targetRef.current.x,
          y: targetRef.current.y,
          z: targetRef.current.z,
        },
        fov,
      };
    },
    setPreset: (preset, extent = buildingExtent) => {
      const pose = computeCameraPose(preset, extent);
      const t = new THREE.Vector3(pose.target.x, pose.target.y, pose.target.z);
      const pos = new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z);

      camera.position.copy(pos);
      camera.lookAt(t);
      camera.updateProjectionMatrix();
      const controls = controlsRef.current;
      if (controls) {
        controls.target.copy(t);
        controls.update();
      }
      targetRef.current.copy(t);
    },
    reset: (extent = buildingExtent) => {
      apiRef.current?.setPreset('perspective', extent);
    },
  };

  return null;
}
