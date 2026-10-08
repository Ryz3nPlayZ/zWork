import type { DemoScenario } from "./types";

export const q1SummaryScenario: DemoScenario = {
  id: "q1-summary",
  userMessage: "Summarize my Q1 report and pull out the three biggest risks",
  activities: [
    { id: "a1", label: "Reading Q1_Report_Final.pdf...", done: true },
    { id: "a2", label: "Found 3 risk sections across 47 pages", done: true },
    { id: "a3", label: "Writing summary...", done: true },
  ],
  assistantMessage:
    "I've read through your Q1 report and identified the three biggest risks. Here's a summary:",
  artifact: {
    type: "doc",
    title: "Q1 Risk Summary",
    content: null,
  },
};
