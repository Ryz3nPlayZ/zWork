import type { DemoScenario } from "./types";

export const meetingTasksScenario: DemoScenario = {
  id: "meeting-tasks",
  userMessage: "What did we agree on in today's product meeting?",
  activities: [
    { id: "a1", label: "Reading meeting_notes_2026-04-30.md...", done: true },
    { id: "a2", label: "Extracted 5 action items", done: true },
    { id: "a3", label: "Adding to your task list...", done: true },
  ],
  assistantMessage:
    "I found 5 action items from today's meeting. I've added them to your task list with suggested due dates.",
  artifact: {
    type: "tasks",
    title: "Action Items — Product Meeting",
    content: null,
  },
};
