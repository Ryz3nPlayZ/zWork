import type { DemoScenario } from "./types";

export const memoryRecallScenario: DemoScenario = {
  id: "memory-recall",
  userMessage: "What was my top priority last Tuesday?",
  activities: [
    { id: "a1", label: "Checking your task history...", done: true },
    { id: "a2", label: "Found 3 tasks from April 22", done: true },
  ],
  assistantMessage:
    "Last Tuesday your top priority was finishing the onboarding flow redesign. You mentioned it was blocking the marketing site launch.",
};
