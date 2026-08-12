'use client';

import { Canvas } from '@react-three/fiber';
import { OrbitControls, ContactShadows } from '@react-three/drei';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import type { BuildingModelV1, BuildingMutation } from '@aihd/domain';
import {
  createDefaultTestBuilding,
  extractShellFromModel,
} from '@aihd/domain';
import * as THREE from 'three';
import { BuildingModel } from './engine/BuildingModel';
import {
  CameraRig,
  type CameraControllerApi,
  type CameraSnapshot,
  type ViewPreset,
} from './engine/camera-state';
import { ViewportControls } from './engine/ViewportControls';
import { DevBuildingPanel, type DevBuildingValues } from './engine/DevBuildingPanel';

type OrbitApi = {
  target: THREE.Vector3;
  update: () => void;
};

function SceneContents({
  model,
  selectedEntityId,
  onSelect,
  controlsRef,
  cameraApiRef,
  buildingExtent,
}: {
  model: BuildingModelV1;
  selectedEntityId: string | null;
  onSelect: (id: string | null) => void;
  controlsRef: MutableRefObject<OrbitApi | null>;
  cameraApiRef: MutableRefObject<CameraControllerApi | null>;
  buildingExtent: number;
}) {
  return (
    <>
      <color attach="background" args={['#e8ece8']} />
      <ambientLight intensity={0.55} />
      <hemisphereLight intensity={0.35} groundColor="#c5c0b5" color="#f5f7f5" />
      <directionalLight
        castShadow
        position={[45, 70, 35]}
        intensity={1.15}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-far={200}
        shadow-camera-left={-80}
        shadow-camera-right={80}
        shadow-camera-top={80}
        shadow-camera-bottom={-80}
      />
      <gridHelper args={[160, 32, '#9aab9c', '#cfd8d0']} position={[0, 0.01, 0]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[200, 200]} />
        <meshStandardMaterial color="#dfe6df" roughness={1} metalness={0} />
      </mesh>
      <BuildingModel model={model} selectedEntityId={selectedEntityId} onSelect={onSelect} />
      <ContactShadows
        position={[0, 0.02, 0]}
        opacity={0.35}
        scale={120}
        blur={2.5}
        far={40}
      />
      <CameraRig
        apiRef={cameraApiRef}
        controlsRef={controlsRef}
        buildingExtent={buildingExtent}
      />
      <OrbitControls
        ref={controlsRef as never}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        maxPolarAngle={Math.PI * 0.495}
        minDistance={8}
        maxDistance={220}
        target={[0, 4, 0]}
      />
    </>
  );
}

/**
 * Live parametric 3D viewport for the project workspace 3D tab.
 * Camera snapshot available via window.__atelierCameraSnapshot for future renders.
 */
export function Scene3DView(props: {
  model: BuildingModelV1;
  selectedEntityId: string | null;
  onSelect: (id: string | null) => void;
  onMutate: (batch: { mutations: BuildingMutation[]; reason?: string }) => Promise<void>;
}) {
  const controlsRef = useRef<OrbitApi | null>(null);
  const cameraApiRef = useRef<CameraControllerApi | null>(null);
  const [viewPreset, setViewPreset] = useState<ViewPreset>('perspective');
  const [busy, setBusy] = useState(false);

  const displayModel = useMemo(() => {
    if (props.model.walls.length > 0 || props.model.shell) return props.model;
    return createDefaultTestBuilding({
      buildingType: props.model.meta.buildingType,
      name: props.model.meta.name,
    });
  }, [props.model]);

  const shell = useMemo(() => {
    return extractShellFromModel(displayModel) ?? createDefaultTestBuilding().shell!;
  }, [displayModel]);

  const buildingExtent = Math.max(shell.width, shell.depth, shell.wallHeight * 2);

  const devValues: DevBuildingValues = {
    width: shell.width,
    depth: shell.depth,
    wallHeight: shell.wallHeight,
    roofType: shell.roof.type,
    pitch: shell.roof.pitch,
    overhang: shell.roof.overhang,
    ridgeDirection: shell.roof.ridgeDirection,
  };

  useEffect(() => {
    (window as unknown as { __atelierCameraSnapshot?: () => CameraSnapshot }).__atelierCameraSnapshot =
      () =>
        cameraApiRef.current?.getSnapshot() ?? {
          position: { x: 40, y: 28, z: 40 },
          target: { x: 0, y: 4, z: 0 },
          fov: 45,
        };
    return () => {
      delete (window as unknown as { __atelierCameraSnapshot?: () => CameraSnapshot })
        .__atelierCameraSnapshot;
    };
  }, []);

  const applyPreset = useCallback(
    (preset: ViewPreset) => {
      setViewPreset(preset);
      cameraApiRef.current?.setPreset(preset, buildingExtent);
    },
    [buildingExtent],
  );

  const resetView = useCallback(() => {
    setViewPreset('perspective');
    cameraApiRef.current?.reset(buildingExtent);
  }, [buildingExtent]);

  async function handleDevChange(patch: Partial<DevBuildingValues>) {
    const next = { ...devValues, ...patch };
    const mutations: BuildingMutation[] = [];

    if (patch.width != null || patch.depth != null || patch.wallHeight != null) {
      mutations.push({
        op: 'updateBuildingDimensions',
        width: next.width,
        depth: next.depth,
        wallHeight: next.wallHeight,
      });
    }

    if (
      patch.roofType != null ||
      patch.pitch != null ||
      patch.overhang != null ||
      patch.ridgeDirection != null
    ) {
      mutations.push({
        op: 'updateRoof',
        patch: {
          type: next.roofType,
          pitch: next.pitch,
          overhang: next.overhang,
          ridgeDirection: next.ridgeDirection,
        },
      });
    }

    if (mutations.length === 0) return;

    const batch: BuildingMutation[] =
      props.model.walls.length === 0 && !props.model.shell
        ? [
            {
              op: 'setShell',
              shell: createDefaultTestBuilding({
                buildingType: props.model.meta.buildingType,
                name: props.model.meta.name,
              }).shell!,
            },
            ...mutations,
          ]
        : mutations;

    setBusy(true);
    try {
      await props.onMutate({
        reason: 'Dev panel building shell edit',
        mutations: batch,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scene-3d-root">
      <Canvas
        shadows
        dpr={[1, 1.75]}
        camera={{ position: [42, 30, 42], fov: 40, near: 0.1, far: 500 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        onPointerMissed={() => props.onSelect(null)}
        style={{ width: '100%', height: '100%' }}
      >
        <SceneContents
          model={displayModel}
          selectedEntityId={props.selectedEntityId}
          onSelect={props.onSelect}
          controlsRef={controlsRef}
          cameraApiRef={cameraApiRef}
          buildingExtent={buildingExtent}
        />
      </Canvas>
      <ViewportControls active={viewPreset} onPreset={applyPreset} onReset={resetView} />
      {/* DEV ONLY — remove DevBuildingPanel import + this line when done testing */}
      <DevBuildingPanel values={devValues} onChange={handleDevChange} busy={busy} />
    </div>
  );
}
