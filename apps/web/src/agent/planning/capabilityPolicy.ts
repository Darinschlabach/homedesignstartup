export type GeometryDomain = "stairs" | "walls" | "level_footprint";

export type UnsupportedCapability = {
  domain: GeometryDomain;
  requested: string;
  code: "UNSUPPORTED_CAPABILITY";
  supportedAlternatives: string[];
};

export type CapabilityAssessment = {
  approximationAuthorized: boolean;
  blocked: UnsupportedCapability[];
};

type CapabilityDefinition = {
  domain: GeometryDomain;
  entityPattern: RegExp;
  unsupported: Array<{
    label: string;
    pattern: RegExp;
  }>;
  supportedAlternatives: string[];
};

/**
 * Geometry capability metadata shared by request preflight and tool policy.
 * Keep this aligned with the actual domain schemas/tool contracts.
 */
export const GEOMETRY_CAPABILITIES: CapabilityDefinition[] = [
  {
    domain: "stairs",
    entityPattern: /\bstair(?:s|case|way)?\b/i,
    unsupported: [
      { label: "spiral stair", pattern: /\bspiral\b/i },
      { label: "curved stair", pattern: /\bcurv(?:e|ed|ing|ilinear)\b/i },
      { label: "winder stair", pattern: /\bwinder\b/i },
      { label: "U-shaped stair", pattern: /\bu[- ]?shap(?:e|ed)\b/i },
    ],
    supportedAlternatives: ["straight stair", "L-shaped stair"],
  },
  {
    domain: "walls",
    entityPattern: /\bwall(?:s)?\b/i,
    unsupported: [
      { label: "curved wall", pattern: /\b(?:curv(?:e|ed|ing|ilinear)|arc(?:ed)?)\b/i },
    ],
    supportedAlternatives: ["straight wall segments"],
  },
  {
    domain: "level_footprint",
    entityPattern: /\b(?:footprint|upper[- ]?level|second[- ]?(?:floor|story|storey))\b/i,
    unsupported: [
      { label: "freeform footprint", pattern: /\b(?:free[- ]?form|non[- ]?rectangular|polygonal)\b/i },
      { label: "rotated footprint", pattern: /\b(?:rotat(?:e|ed)|angled)\b/i },
    ],
    supportedAlternatives: ["axis-aligned rectangular footprint"],
  },
];

export function explicitlyAuthorizesApproximation(message: string): boolean {
  return /\b(?:approximation|approximate|substitut(?:e|ion)|alternative|closest supported|faceted|segmented)\b[^.!?]{0,80}\b(?:is|are|would be)?\s*(?:ok(?:ay)?|acceptable|fine|allowed|authorized|use|do)\b/i.test(message) ||
    /\b(?:you may|you can|feel free to|go ahead and)\b[^.!?]{0,80}\b(?:approximate|substitute|use (?:a |an )?(?:supported|straight|segmented|faceted|rectangular))\b/i.test(message);
}

export function assessCapabilityRequest(message: string): CapabilityAssessment {
  const approximationAuthorized = explicitlyAuthorizesApproximation(message);
  const blocked: UnsupportedCapability[] = [];

  for (const definition of GEOMETRY_CAPABILITIES) {
    if (!definition.entityPattern.test(message)) continue;
    for (const unsupported of definition.unsupported) {
      if (!unsupported.pattern.test(message)) continue;
      blocked.push({
        domain: definition.domain,
        requested: unsupported.label,
        code: "UNSUPPORTED_CAPABILITY",
        supportedAlternatives: definition.supportedAlternatives,
      });
    }
  }

  return {
    approximationAuthorized,
    blocked: approximationAuthorized ? [] : blocked,
  };
}

const OP_DOMAIN: Record<string, GeometryDomain | undefined> = {
  createStair: "stairs",
  updateStair: "stairs",
  deleteStair: "stairs",
  createWall: "walls",
  updateWall: "walls",
  deleteWall: "walls",
  setLevelFootprint: "level_footprint",
  updateLevelFootprint: "level_footprint",
  clearLevelFootprint: "level_footprint",
};

export function blockedCapabilityForOperations(
  assessment: CapabilityAssessment,
  operations: Array<{ op: string }>,
): UnsupportedCapability | null {
  if (assessment.approximationAuthorized) return null;
  const domains = new Set(operations.map((operation) => OP_DOMAIN[operation.op]));
  return assessment.blocked.find((item) => domains.has(item.domain)) ?? null;
}

export function capabilityBoundaryPrompt(assessment: CapabilityAssessment): string | null {
  if (assessment.blocked.length === 0) return null;
  const details = assessment.blocked
    .map(
      (item) =>
        `${item.requested} is unsupported; supported alternatives: ${item.supportedAlternatives.join(", ")}`,
    )
    .join("; ");
  return `CAPABILITY BOUNDARY (server-enforced): ${details}. The user did not authorize approximation. Do not call mutation tools in the blocked domains. Explain the limitation and offer alternatives without executing them.`;
}
