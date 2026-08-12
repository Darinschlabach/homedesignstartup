/**
 * Known starting models for agent evaluation.
 * Single-story: kitchen / living / garage with a partition (cramped living).
 * Two-story: same + full L2, straight stair, two upstairs bedrooms.
 */
import {
  applyDesignOperations,
  createDefaultTestBuilding,
  type BuildingModelV1,
} from "@aihd/domain";

export function buildSingleStoryEvalFixture(): BuildingModelV1 {
  const base = createDefaultTestBuilding({
    name: "Eval House",
    buildingType: "home",
  });

  return applyDesignOperations(base, [
    {
      op: "createWall",
      wall: {
        id: "wall-kitchen-garage",
        levelId: "level-1",
        kind: "interior",
        start: { x: -4, y: -30 },
        end: { x: -4, y: -6 },
        thickness: 0.5,
      },
    },
    {
      op: "createWall",
      wall: {
        id: "wall-living-front",
        levelId: "level-1",
        kind: "interior",
        start: { x: -20, y: -6 },
        end: { x: 20, y: -6 },
        thickness: 0.5,
      },
    },
    {
      op: "createSpace",
      space: {
        id: "space-kitchen",
        name: "Kitchen",
        levelId: "level-1",
        polygon: [
          { x: -20, y: -30 },
          { x: -4, y: -30 },
          { x: -4, y: -6 },
          { x: -20, y: -6 },
        ],
        tags: ["kitchen"],
      },
    },
    {
      op: "createSpace",
      space: {
        id: "space-garage",
        name: "Garage",
        levelId: "level-1",
        polygon: [
          { x: -4, y: -30 },
          { x: 20, y: -30 },
          { x: 20, y: -6 },
          { x: -4, y: -6 },
        ],
        tags: ["garage"],
      },
    },
    {
      op: "createSpace",
      space: {
        id: "space-living",
        name: "Living Room",
        levelId: "level-1",
        polygon: [
          { x: -20, y: -6 },
          { x: 20, y: -6 },
          { x: 20, y: 30 },
          { x: -20, y: 30 },
        ],
        tags: ["living"],
      },
    },
  ]);
}

export function buildTwoStoryEvalFixture(single?: BuildingModelV1): BuildingModelV1 {
  const base = single ?? buildSingleStoryEvalFixture();
  return applyDesignOperations(base, [
    {
      op: "createLevel",
      name: "Second Floor",
      height: 9,
      footprintSource: "shell",
    },
    {
      op: "createStair",
      id: "stair-main",
      name: "Main Stair",
      type: "straight",
      fromLevelId: "level-1",
      toLevelId: "level-2",
      origin: { x: -6, y: -18 },
      directionDeg: 90,
      width: 3.5,
      availableRun: 12,
    },
    {
      op: "createSpace",
      space: {
        id: "space-bed-1",
        name: "Bedroom 1",
        levelId: "level-2",
        polygon: [
          { x: -18, y: -26 },
          { x: -1, y: -26 },
          { x: -1, y: -2 },
          { x: -18, y: -2 },
        ],
        tags: ["bedroom"],
      },
    },
    {
      op: "createSpace",
      space: {
        id: "space-bed-2",
        name: "Bedroom 2",
        levelId: "level-2",
        polygon: [
          { x: 1, y: -26 },
          { x: 18, y: -26 },
          { x: 18, y: -2 },
          { x: 1, y: -2 },
        ],
        tags: ["bedroom"],
      },
    },
    {
      op: "createOpening",
      opening: {
        id: "window-l2-front",
        wall: "front",
        type: "window",
        width: 4,
        height: 4,
        sillHeight: 3,
        position: "center",
        levelId: "level-2",
      },
    },
  ]);
}
