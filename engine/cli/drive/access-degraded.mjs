// The access-degraded decision's answers. The keys are what a human's answer is compared against
// (engine.mjs PROCEED_DEGRADED_ANSWER) and what stages/plan/SKILL.md quotes, so they never change here alone.
export const ACCESS_DEGRADED_OPTIONS = [
  "retry — now reachable",
  "offline copy at path: <free-text>",
  "proceed degraded (accept degraded confidence)",
];

export const ACCESS_DEGRADED_DETAILS = {
  [ACCESS_DEGRADED_OPTIONS[0]]: {
    label: "Retry the source",
    consequence: "The source is probed again and the decision closes if it answers.",
    then: "Then research reruns on the reachable source.",
  },
  [ACCESS_DEGRADED_OPTIONS[1]]: {
    label: "Use an offline copy",
    consequence: "Research reads the copy you name instead of the live source.",
    then: "Then the findings that rest on it stay marked degraded.",
  },
  [ACCESS_DEGRADED_OPTIONS[2]]: {
    label: "Proceed with degraded confidence",
    consequence: "Implementation starts with the blocked source unread.",
    then: "Then every finding that rests on it keeps its degraded tag.",
  },
};

// Never `recommended`: only a human may choose to proceed degraded.
export const ACCESS_DEGRADED_NO_RECOMMENDATION =
  "Only you can accept degraded confidence, so the engine recommends none of these.";
