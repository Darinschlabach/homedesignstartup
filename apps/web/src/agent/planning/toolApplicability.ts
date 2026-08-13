export type LevelFootprintSource = "shell" | "custom";
export type LevelFootprintTransition =
  | "set_level_footprint"
  | "modify_level_footprint"
  | "clear_level_footprint";

export function validLevelFootprintTransitions(
  source: LevelFootprintSource,
): LevelFootprintTransition[] {
  return source === "shell"
    ? ["set_level_footprint"]
    : ["modify_level_footprint", "clear_level_footprint"];
}

export function checkLevelFootprintTransition(
  source: LevelFootprintSource,
  requested: LevelFootprintTransition,
):
  | { applicable: true; validTransitions: LevelFootprintTransition[] }
  | {
      applicable: false;
      code: "TOOL_NOT_APPLICABLE";
      reason: string;
      validTransitions: LevelFootprintTransition[];
    } {
  const validTransitions = validLevelFootprintTransitions(source);
  if (validTransitions.includes(requested)) {
    return { applicable: true, validTransitions };
  }
  return {
    applicable: false,
    code: "TOOL_NOT_APPLICABLE",
    reason: `Level is ${source}-backed. Valid transition${validTransitions.length === 1 ? " is" : "s are"}: ${validTransitions.join(", ")}.`,
    validTransitions,
  };
}

export function resolveLevelFootprintUpdate(
  source: LevelFootprintSource,
  patch: {
    centerX?: number;
    centerZ?: number;
    width?: number;
    depth?: number;
  },
):
  | { applicable: true; transition: "modify_level_footprint" }
  | { applicable: true; transition: "set_level_footprint"; rectangle: Required<typeof patch> }
  | {
      applicable: false;
      code: "TOOL_NOT_APPLICABLE";
      reason: string;
      validTransitions: LevelFootprintTransition[];
      requiredArguments: string[];
    } {
  if (source === "custom") {
    return { applicable: true, transition: "modify_level_footprint" };
  }
  const requiredArguments = (["centerX", "centerZ", "width", "depth"] as const)
    .filter((key) => patch[key] === undefined);
  if (requiredArguments.length > 0) {
    return {
      applicable: false,
      code: "TOOL_NOT_APPLICABLE",
      reason: `Level is shell-backed. A complete rectangle is required to transition with set_level_footprint; missing: ${requiredArguments.join(", ")}.`,
      validTransitions: ["set_level_footprint"],
      requiredArguments,
    };
  }
  return {
    applicable: true,
    transition: "set_level_footprint",
    rectangle: patch as Required<typeof patch>,
  };
}
