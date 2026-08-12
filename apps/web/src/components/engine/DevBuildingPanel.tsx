'use client';

/**
 * Temporary development panel for live parametric testing.
 * Remove this file (and its import from Scene3DView) when no longer needed.
 */

export interface DevBuildingValues {
  width: number;
  depth: number;
  wallHeight: number;
  roofType: 'gable' | 'hip' | 'shed' | 'flat';
  pitch: number;
  overhang: number;
  ridgeDirection: 'width' | 'depth';
}

export function DevBuildingPanel({
  values,
  onChange,
  busy,
}: {
  values: DevBuildingValues;
  onChange: (patch: Partial<DevBuildingValues>) => void;
  busy?: boolean;
}) {
  return (
    <div className="dev-building-panel" data-dev-panel="building-shell">
      <div className="dev-building-panel-title">Dev · Building shell</div>
      <label>
        Width (ft)
        <input
          type="number"
          min={10}
          max={200}
          step={1}
          disabled={busy}
          value={values.width}
          onChange={(e) => onChange({ width: Number(e.target.value) })}
        />
      </label>
      <label>
        Depth (ft)
        <input
          type="number"
          min={10}
          max={200}
          step={1}
          disabled={busy}
          value={values.depth}
          onChange={(e) => onChange({ depth: Number(e.target.value) })}
        />
      </label>
      <label>
        Wall height (ft)
        <input
          type="number"
          min={7}
          max={30}
          step={0.5}
          disabled={busy}
          value={values.wallHeight}
          onChange={(e) => onChange({ wallHeight: Number(e.target.value) })}
        />
      </label>
      <label>
        Roof type
        <select
          disabled={busy}
          value={values.roofType}
          onChange={(e) =>
            onChange({
              roofType: e.target.value as 'gable' | 'hip' | 'shed' | 'flat',
            })
          }
        >
          <option value="gable">Gable</option>
          <option value="hip">Hip</option>
          <option value="shed">Shed</option>
          <option value="flat">Flat</option>
        </select>
      </label>
      <label>
        Pitch (X/12)
        <input
          type="number"
          min={2}
          max={18}
          step={1}
          disabled={busy}
          value={values.pitch}
          onChange={(e) => onChange({ pitch: Number(e.target.value) })}
        />
      </label>
      <label>
        Overhang (ft)
        <input
          type="number"
          min={0}
          max={6}
          step={0.25}
          disabled={busy}
          value={values.overhang}
          onChange={(e) => onChange({ overhang: Number(e.target.value) })}
        />
      </label>
      <label>
        Ridge
        <select
          disabled={busy}
          value={values.ridgeDirection}
          onChange={(e) =>
            onChange({ ridgeDirection: e.target.value as 'width' | 'depth' })
          }
        >
          <option value="depth">Along depth</option>
          <option value="width">Along width</option>
        </select>
      </label>
    </div>
  );
}
