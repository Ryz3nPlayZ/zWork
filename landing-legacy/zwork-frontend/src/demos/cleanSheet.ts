import type { DemoScenario } from "./types";

export const cleanSheetScenario: DemoScenario = {
  id: "clean-sheet",
  userMessage: "Clean up this messy revenue export and sort by amount",
  activities: [
    { id: "a1", label: "Reading revenue_export_march.csv...", done: true },
    { id: "a2", label: "Removed 12 duplicate rows", done: true },
    { id: "a3", label: "Normalized currency and dates", done: true },
    { id: "a4", label: "Sorting by amount descending...", done: true },
  ],
  assistantMessage:
    "Done. I removed duplicates, fixed formatting, and sorted by revenue. The cleaned sheet is ready.",
  artifact: {
    type: "sheet",
    title: "Revenue — March (Cleaned)",
    content: null,
  },
};
