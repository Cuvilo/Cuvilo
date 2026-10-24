import type { Transition } from "motion/react";

// Shared timings: feedback is immediate; larger surfaces settle more slowly.
export const motionTokens = {
  navigation: { type: "spring", stiffness: 440, damping: 36, mass: 0.8 },
  layout: { type: "spring", stiffness: 380, damping: 34, mass: 0.8 },
  enter: { duration: 0.16, ease: [0.2, 0, 0, 1] },
} satisfies Record<string, Transition>;
