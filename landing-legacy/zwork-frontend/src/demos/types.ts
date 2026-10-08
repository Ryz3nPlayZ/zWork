export interface DemoActivity {
  id: string;
  label: string;
  done?: boolean;
}

export interface DemoArtifact {
  type: "doc" | "sheet" | "tasks" | "graph";
  title: string;
  content: React.ReactNode;
}

export interface DemoScenario {
  id: string;
  userMessage: string;
  activities: DemoActivity[];
  assistantMessage?: string;
  artifact?: DemoArtifact;
}
