/** The recurring office work zWork is for (docs/POSITIONING.md). Used by onboarding
 *  and the home screen. Each prompt reads as the user's own request and ends the
 *  first session with one checked result and an offer to schedule it. */
export interface Chore {
  id: string;
  label: string;
  prompt: string;
}

export const CHORES: Chore[] = [
  {
    id: "expense-report",
    label: "Monthly expense report",
    prompt:
      "Set up my monthly expense report. Ask me which bank or card export to use and what the report should look like, make it once as an Excel file so I can check it, then offer to repeat it every month.",
  },
  {
    id: "inbox-digest",
    label: "Morning inbox summary",
    prompt:
      "Summarize my inbox each morning: what needs a reply, what can wait, and any dates or deadlines. Ask me which email account to use, do it once so I can check it, then offer to repeat it every weekday.",
  },
  {
    id: "chase-invoices",
    label: "Chase unpaid invoices",
    prompt:
      "Help me chase unpaid invoices. Ask me where my list of invoices is, draft a polite reminder for each overdue one, and show me before anything is sent. Then offer to repeat it every week.",
  },
  {
    id: "client-update",
    label: "Weekly client update",
    prompt:
      "Write my weekly client update. Ask me who it's for and where the news comes from, draft it once as a Word file so I can check it, then offer to repeat it every week.",
  },
  {
    id: "research-brief",
    label: "Research a topic into notes",
    prompt:
      "Research a topic for me and write it up as short notes with links to the sources. Ask me the topic and what I need it for, do it once so I can check it, then offer to repeat it every week with what's new.",
  },
  {
    id: "fill-template",
    label: "Fill a template for each client",
    prompt:
      "Fill my template for each new client or order. Ask me where the template and the list are, make the documents once so I can check them, then offer to repeat it.",
  },
];
