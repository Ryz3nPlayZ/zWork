/** State of one simulated zWork window. Scenarios (scenarios.ts) drive it
 *  forward on a GSAP timeline; the clone components only render it. */

export type ToolIcon =
  | "wrench"
  | "terminal"
  | "file"
  | "code"
  | "globe"
  | "mail"
  | "calendar"
  | "message"
  | "pointer"
  | "search"
  | "table";

export type Step = { id: string; label: string; icon: ToolIcon; done: boolean };

export type ArtifactKind = "report" | "sheet" | "email";

export type UserMsg = { id: string; role: "user"; text: string; time: string; attachment?: string };

export type AssistantMsg = {
  id: string;
  role: "assistant";
  steps: Step[];
  stepsOpen: boolean;
  working: boolean;
  /** Markdown-ish: blank-line paragraphs, "- " bullets, **bold**, *italic*, `code`. */
  text: string;
  streaming: boolean;
  artifact?: { title: string; kind: ArtifactKind };
  footer?: string;
};

export type Msg = UserMsg | AssistantMsg;

export type Permission = {
  title: string;
  reason: string;
  detail?: string;
  chosen?: "allow" | "deny";
};

export type Task = {
  id: string;
  title: string;
  trigger: string;
  next: string;
  last?: string;
  enabled: boolean;
  running?: boolean;
  repeat?: boolean;
  isNew?: boolean;
};

export type InboxKind = "summary" | "flag" | "question" | "error";

export type InboxItem = {
  id: string;
  title: string;
  kind: InboxKind;
  body: string;
  time: string;
  read: boolean;
  open?: boolean;
  isNew?: boolean;
};

export type HistoryItem = { id: string; title: string; bucket: "Today" | "This week" | "Earlier" };

export type View = "welcome" | "chat" | "scheduled" | "inbox";

export type Preset = "ask" | "edit" | "plan" | "full";

export type Panel = {
  title: string;
  kind: ArtifactKind;
  /** How much of the document has been written so far (0..1). */
  progress: number;
};

export type CloneState = {
  view: View;
  history: HistoryItem[];
  activeChat: string | null;
  chatTitle: string;
  messages: Msg[];
  composer: string;
  composerFocus: boolean;
  working: boolean;
  workingWord: string;
  permission: Permission | null;
  panel: Panel | null;
  tasks: Task[];
  inbox: InboxItem[];
  model: string;
  preset: Preset;
  modelMenu: boolean;
  /** data-target of the control currently shown pressed. */
  pressed: string | null;
};
