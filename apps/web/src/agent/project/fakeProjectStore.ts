/**
 * In-memory fake project for standalone Home Design Agent testing.
 * Shared by inspect_project and modify_object — not connected to DB or 3D.
 */

export type FakePosition = {
  x?: number;
  y?: number;
  z?: number;
};

export type FakeProjectObject = {
  id: string;
  type: string;
  location?: string;
  width?: number;
  height?: number;
  depth?: number;
  position?: FakePosition;
};

export type FakeRoom = {
  id: string;
  name: string;
  width: number;
  depth: number;
};

export type FakeProject = {
  projectType: string;
  dimensions: {
    width: number;
    depth: number;
  };
  floors: number;
  rooms: FakeRoom[];
  objects: FakeProjectObject[];
};

function createDefaultFakeProject(): FakeProject {
  return {
    projectType: "house",
    dimensions: {
      width: 40,
      depth: 60,
    },
    floors: 1,
    rooms: [
      {
        id: "kitchen_01",
        name: "Kitchen",
        width: 16,
        depth: 18,
      },
    ],
    objects: [
      {
        id: "window_01",
        type: "window",
        location: "front wall",
        width: 36,
        height: 60,
      },
      {
        id: "window_02",
        type: "window",
        location: "front wall",
        width: 36,
        height: 60,
      },
    ],
  };
}

let project: FakeProject = createDefaultFakeProject();

function cloneProject(value: FakeProject): FakeProject {
  return structuredClone(value);
}

function cloneObject(value: FakeProjectObject): FakeProjectObject {
  return structuredClone(value);
}

export function getFakeProject(): FakeProject {
  return cloneProject(project);
}

export function resetFakeProject(): void {
  project = createDefaultFakeProject();
}

export type ModifyObjectInput = {
  objectId: string;
  width?: number;
  height?: number;
  depth?: number;
  position?: FakePosition;
};

export type ModifyObjectResult =
  | {
      success: true;
      objectId: string;
      before: FakeProjectObject;
      after: FakeProjectObject;
    }
  | {
      success: false;
      objectId: string;
      error: string;
    };

export function modifyFakeObject(input: ModifyObjectInput): ModifyObjectResult {
  const index = project.objects.findIndex((obj) => obj.id === input.objectId);
  if (index === -1) {
    return {
      success: false,
      objectId: input.objectId,
      error: `Object not found: ${input.objectId}`,
    };
  }

  const current = project.objects[index]!;
  const before = cloneObject(current);

  const next: FakeProjectObject = {
    ...current,
  };

  if (input.width !== undefined) next.width = input.width;
  if (input.height !== undefined) next.height = input.height;
  if (input.depth !== undefined) next.depth = input.depth;
  if (input.position !== undefined) {
    next.position = {
      ...(current.position ?? {}),
      ...compactPosition(input.position),
    };
  }

  project.objects[index] = next;

  return {
    success: true,
    objectId: input.objectId,
    before,
    after: cloneObject(next),
  };
}

function compactPosition(position: FakePosition): FakePosition {
  const next: FakePosition = {};
  if (position.x !== undefined) next.x = position.x;
  if (position.y !== undefined) next.y = position.y;
  if (position.z !== undefined) next.z = position.z;
  return next;
}
