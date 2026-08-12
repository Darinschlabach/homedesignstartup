/**
 * Development evaluation scenarios for the Home Design Agent.
 * Constraint checks only — do not encode expected tool sequences.
 */

export type EvalFixtureKind = "singleStory" | "twoStory";

export type EvalScenarioId =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10;

export type EvalScenario = {
  id: EvalScenarioId;
  title: string;
  message: string;
  fixture: EvalFixtureKind;
  /** Visual inspect/render is expected before broad design changes. */
  visualAppropriate: boolean;
  /** Inspect/render should happen before the first mutation. */
  inspectBeforeMutate: boolean;
  notes: string;
};

export const EVAL_SCENARIOS: EvalScenario[] = [
  {
    id: 1,
    title: "Exterior improvement",
    message:
      "I don't like the front of this house. Improve it however you think looks best, but keep the overall footprint.",
    fixture: "singleStory",
    visualAppropriate: true,
    inspectBeforeMutate: true,
    notes: "May use openings, materials, roof, roof masses, placed objects. Footprint must stay.",
  },
  {
    id: 2,
    title: "Interior planning",
    message:
      "The main living area feels cramped. Rework the floor plan so the kitchen and living room feel more open without increasing the footprint.",
    fixture: "singleStory",
    visualAppropriate: false,
    inspectBeforeMutate: true,
    notes: "Interior walls/spaces; footprint unchanged.",
  },
  {
    id: 3,
    title: "Second-story addition",
    message:
      "Add a partial second floor with two bedrooms wherever it makes the most sense. Keep the house from looking too top-heavy and make sure there is a usable staircase.",
    fixture: "singleStory",
    visualAppropriate: true,
    inspectBeforeMutate: true,
    notes: "Partial L2 + 2 bedrooms + stair; not top-heavy.",
  },
  {
    id: 4,
    title: "Exterior massing",
    message:
      "Give this house a more interesting roof and second-story composition without changing the first-floor footprint.",
    fixture: "twoStory",
    visualAppropriate: true,
    inspectBeforeMutate: true,
    notes: "Roof and/or L2 composition; L1 footprint stays.",
  },
  {
    id: 5,
    title: "Open-ended improvement",
    message: "Look at the entire house and improve the design wherever you think it needs work.",
    fixture: "singleStory",
    visualAppropriate: true,
    inspectBeforeMutate: true,
    notes: "Agent chooses where to work; should inspect/render first.",
  },
  {
    id: 6,
    title: "Constraint-heavy request",
    message:
      "Make the second floor smaller, keep the existing staircase, do not move the front door, and don't change the garage width.",
    fixture: "twoStory",
    visualAppropriate: false,
    inspectBeforeMutate: true,
    notes: "L2 shrink; stair/front door/garage width preserved.",
  },
  {
    id: 7,
    title: "Material design",
    message:
      "Make the exterior feel warmer and more expensive without changing the geometry. You are not limited to existing materials.",
    fixture: "singleStory",
    visualAppropriate: true,
    inspectBeforeMutate: false,
    notes: "Materials only; geometry frozen; new materials allowed.",
  },
  {
    id: 8,
    title: "Ambiguous request",
    message: "This just doesn't feel right. Fix it.",
    fixture: "singleStory",
    visualAppropriate: true,
    inspectBeforeMutate: true,
    notes: "Must inspect/render before broad assumptions.",
  },
  {
    id: 9,
    title: "Unsupported request",
    message: "Add a spiral staircase and a curved glass wall on the second floor.",
    fixture: "twoStory",
    visualAppropriate: false,
    inspectBeforeMutate: false,
    notes: "Should identify unsupported capabilities rather than fake them.",
  },
  {
    id: 10,
    title: "Large coordinated change",
    message:
      "Turn this into a two-story four-bedroom home with a more interesting exterior, but keep the existing building footprint and garage location.",
    fixture: "singleStory",
    visualAppropriate: true,
    inspectBeforeMutate: true,
    notes: "2 stories, 4 bedrooms, interesting exterior; footprint + garage stay.",
  },
];

export function parseScenarioFilter(raw: string | undefined): EvalScenarioId[] | null {
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 10) as EvalScenarioId[];
  return ids.length ? ids : null;
}
