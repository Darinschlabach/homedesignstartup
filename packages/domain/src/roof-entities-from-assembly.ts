/**
 * Generate DesignEntity graph from durable RoofAssembly data.
 */
import type { DesignEntity } from './entities';
import type { RoofAssembly } from './roof-assembly';

export function generateRoofEntitiesFromAssemblies(
  assemblies: RoofAssembly[],
): DesignEntity[] {
  const entities: DesignEntity[] = [];

  for (const assembly of assemblies) {
    const gen = assembly.masses[0]?.generator;
    entities.push({
      id: assembly.id,
      type: 'roofAssembly',
      levelId: assembly.levelId,
      geometry: {
        footprint: gen
          ? [
              {
                x: gen.origin.x - gen.width / 2,
                y: gen.origin.y - gen.depth / 2,
              },
              {
                x: gen.origin.x + gen.width / 2,
                y: gen.origin.y - gen.depth / 2,
              },
              {
                x: gen.origin.x + gen.width / 2,
                y: gen.origin.y + gen.depth / 2,
              },
              {
                x: gen.origin.x - gen.width / 2,
                y: gen.origin.y + gen.depth / 2,
              },
            ]
          : [],
        overhang: gen?.overhang,
        pitch: gen?.pitch,
        ridgeDirection: gen?.ridgeDirection,
        massCount: assembly.masses.length,
        planeCount: assembly.planes.length,
        edgeCount: assembly.edges.length,
      },
      properties: {
        source: assembly.source,
        kind: gen?.type ?? 'composed',
        generator: gen?.type,
        massIds: assembly.masses.map((m) => m.id),
      },
      materialId: assembly.materialId,
    });

    for (const plane of assembly.planes) {
      entities.push({
        id: plane.id,
        type: 'roofPlane',
        parentId: assembly.id,
        levelId: assembly.levelId,
        geometry: {
          vertices: plane.boundary.map((v) => ({ ...v })),
          pitch: plane.pitch,
          role: plane.role,
          fallDirection: plane.fallDirection,
        },
        properties: {
          role: plane.role,
          massId: plane.massId,
          face: plane.role,
        },
        materialId: plane.materialId ?? assembly.materialId,
      });
    }

    for (const edge of assembly.edges) {
      if (edge.kind === 'ridge') {
        entities.push({
          id: edge.id,
          type: 'ridge',
          parentId: assembly.id,
          levelId: assembly.levelId,
          geometry: {
            start: { ...edge.start },
            end: { ...edge.end },
          },
          properties: {
            kind: edge.kind,
            planeIds: edge.planeIds,
          },
        });
      } else if (edge.kind === 'valley' || edge.kind === 'hip') {
        entities.push({
          id: edge.id,
          type: 'ridge',
          parentId: assembly.id,
          levelId: assembly.levelId,
          geometry: {
            start: { ...edge.start },
            end: { ...edge.end },
          },
          properties: {
            kind: edge.kind,
            planeIds: edge.planeIds,
          },
          meta: { edgeKind: edge.kind },
        });
      }
    }
  }

  return entities;
}
