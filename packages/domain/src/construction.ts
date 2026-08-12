import type { BuildingModelV1 } from './building-model';
import { buildFloorPlanView, floorPlanToSvg } from './adapters/floor-plan';
import { summarizeBuilding } from './summary';

export interface AdvisoryFinding {
  id: string;
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
}

export interface ConstructionDocumentSet {
  projectName: string;
  generatedAt: string;
  sheets: Array<{
    id: string;
    title: string;
    kind: 'floor-plan' | 'elevation' | 'schedule' | 'notes';
    svg?: string;
    markdown: string;
  }>;
  advisories: AdvisoryFinding[];
}

export function runAdvisoryChecks(model: BuildingModelV1): AdvisoryFinding[] {
  const findings: AdvisoryFinding[] = [];
  const summary = summarizeBuilding(model);

  if (model.walls.length === 0) {
    findings.push({
      id: 'adv-no-walls',
      severity: 'error',
      code: 'EMPTY_MODEL',
      message: 'Building has no walls; cannot produce construction documents.',
    });
  }

  if (model.openings.filter((o) => o.kind === 'door').length === 0) {
    findings.push({
      id: 'adv-no-door',
      severity: 'warning',
      code: 'EGRESS',
      message: 'No doors found. Confirm egress requirements with a licensed professional.',
    });
  }

  if (summary.approximateFootprintSqFt > 0 && summary.approximateFootprintSqFt < 100) {
    findings.push({
      id: 'adv-small',
      severity: 'info',
      code: 'FOOTPRINT',
      message: 'Footprint is under 100 sq ft — verify intended scale/units.',
    });
  }

  if (model.meta.buildingType === 'home' && model.meta.stories > 1 && model.levels.length < 2) {
    findings.push({
      id: 'adv-stories',
      severity: 'warning',
      code: 'LEVELS',
      message: 'Stories meta says multi-story but only one level is defined.',
    });
  }

  findings.push({
    id: 'adv-disclaimer',
    severity: 'info',
    code: 'NOT_STAMPED',
    message:
      'These documents are advisory design aids only and are not stamped construction documents.',
  });

  return findings;
}

export function buildConstructionDocuments(model: BuildingModelV1): ConstructionDocumentSet {
  const summary = summarizeBuilding(model);
  const plan = buildFloorPlanView(model);
  const svg = floorPlanToSvg(plan);
  const advisories = runAdvisoryChecks(model);

  const doorSchedule = model.openings
    .filter((o) => o.kind === 'door')
    .map((o) => `| ${o.id} | door | ${o.width}' x ${o.height}' |`)
    .join('\n');

  const windowSchedule = model.openings
    .filter((o) => o.kind === 'window')
    .map((o) => `| ${o.id} | window | ${o.width}' x ${o.height}' | sill ${o.sillHeight}' |`)
    .join('\n');

  return {
    projectName: model.meta.name,
    generatedAt: new Date().toISOString(),
    sheets: [
      {
        id: 'A-101',
        title: 'Floor Plan',
        kind: 'floor-plan',
        svg,
        markdown: `# Floor Plan — ${model.meta.name}\n\nApprox. footprint: ${summary.approximateFootprintSqFt} sq ft\n`,
      },
      {
        id: 'A-201',
        title: 'Elevations (schematic)',
        kind: 'elevation',
        markdown: `# Elevations — ${model.meta.name}\n\nSchematic elevations derived from wall heights.\n\nEave/wall height (level 1): ${model.levels[0]?.height ?? 'n/a'}'\n`,
      },
      {
        id: 'A-601',
        title: 'Door & Window Schedule',
        kind: 'schedule',
        markdown: `# Schedules\n\n## Doors\n| ID | Type | Size |\n|---|---|---|\n${doorSchedule || '| — | — | — |'}\n\n## Windows\n| ID | Type | Size | Sill |\n|---|---|---|---|\n${windowSchedule || '| — | — | — | — |'}\n`,
      },
      {
        id: 'G-001',
        title: 'General Notes',
        kind: 'notes',
        markdown: `# General Notes\n\n- Design is AI-assisted and must be reviewed by licensed professionals before construction.\n- Verify local zoning, setbacks, snow/wind loads, and energy code.\n- Building type: ${model.meta.buildingType}\n- Units: ${model.meta.units}\n`,
      },
    ],
    advisories,
  };
}

/** DXF-lite: LINE entities for walls in model XY (mapped to DXF XY). */
export function exportDxfLite(model: BuildingModelV1): string {
  const lines: string[] = ['0', 'SECTION', '2', 'ENTITIES'];
  for (const wall of model.walls) {
    lines.push(
      '0',
      'LINE',
      '8',
      'WALLS',
      '10',
      String(wall.start.x),
      '20',
      String(wall.start.y),
      '30',
      '0',
      '11',
      String(wall.end.x),
      '21',
      String(wall.end.y),
      '31',
      '0',
    );
  }
  lines.push('0', 'ENDSEC', '0', 'EOF');
  return lines.join('\n');
}
