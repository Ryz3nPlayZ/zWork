/**
 * Chat export downloads — shared by the ChatView header and the Windows
 * integrated title bar (TitleBar.tsx), which both offer the Markdown/JSON
 * export menu for the active chat.
 */

import type { Chat } from "./store";

function download(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function slug(chat: Chat): string {
  return chat.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "chat";
}

export function downloadChatMarkdown(chat: Chat): void {
  const markdown = chat.messages
    .map((m) => `### ${m.role === "user" ? "User" : "Assistant"}\n\n${m.content}\n`)
    .join("\n---\n\n");
  download(`${slug(chat)}.md`, markdown, "text/markdown;charset=utf-8;");
}

export function downloadChatJson(chat: Chat): void {
  download(`${slug(chat)}.json`, JSON.stringify(chat.messages, null, 2), "application/json");
}
