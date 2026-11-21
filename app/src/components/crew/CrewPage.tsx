import { useEffect, useState } from "react";
import { ArrowLeft, Bot, MessageSquarePlus, Pencil, Plus, Trash2 } from "lucide-react";
import { useApp } from "../../lib/store";
import type { CrewMember } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardGrid,
  EmptyState,
  OverflowMenu,
  PageShell,
  useConfirm,
} from "../page/Page";
import { CrewAvatar } from "./CrewAvatar";
import { CrewEditor } from "./CrewEditor";

export function CrewPage() {
  const crew = useApp((s) => s.crew);
  const loading = useApp((s) => s.crewLoading);
  const loadError = useApp((s) => s.crewError);
  const fetchCrew = useApp((s) => s.fetchCrew);
  const deleteCrew = useApp((s) => s.deleteCrew);
  const openLanding = useApp((s) => s.openLanding);
  const setChatCrew = useApp((s) => s.setChatCrew);
  const chatSummaries = useApp((s) => s.chatSummaries);
  const scheduledTasks = useApp((s) => s.scheduledTasks);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ member: CrewMember | null } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDialog, confirm] = useConfirm();

  const fetchSchedules = useApp((s) => s.fetchSchedules);
  useEffect(() => {
    void fetchCrew();
    // Scheduled runs happen in the background; poll so avatars show who is working.
    void fetchSchedules();
    const id = window.setInterval(() => void fetchSchedules(), 15_000);
    return () => window.clearInterval(id);
  }, [fetchCrew, fetchSchedules]);

  const selected = crew.find((m) => m.id === selectedId) ?? null;
  const newMember = (
    <Button variant="primary" icon={<Plus />} onClick={() => setEditor({ member: null })}>
      New member
    </Button>
  );

  const remove = async (member: CrewMember) => {
    const ok = await confirm({
      title: `Remove ${member.name}?`,
      body: "Chats and scheduled tasks stay, but future runs no longer use this member's instructions or app limits.",
      confirmLabel: "Remove member",
    });
    if (!ok) return;
    setActionError(null);
    try {
      await deleteCrew(member.id);
      if (selectedId === member.id) setSelectedId(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Couldn't remove that member. Try again.");
    }
  };

  const startChat = (member: CrewMember) => {
    openLanding();
    void setChatCrew(member.id);
  };

  return (
    <PageShell
      title={selected ? selected.name : "Crew"}
      subtitle={selected ? "One member, with their own instructions and app access." : "Named helpers for the jobs you ask zWork to do repeatedly."}
      actions={
        selected ? (
          <>
            <Button icon={<ArrowLeft />} onClick={() => setSelectedId(null)}>All members</Button>
            <Button variant="primary" icon={<MessageSquarePlus />} onClick={() => startChat(selected)}>New chat</Button>
          </>
        ) : crew.length > 0 ? newMember : undefined
      }
    >
      {loading && crew.length === 0 ? (
        <div role="status" className="rounded-2xl border border-line bg-paper-raised px-4 py-10 text-center text-[13px] text-ink-muted">
          Loading your crew…
        </div>
      ) : loadError && crew.length === 0 ? (
        <EmptyState
          icon={<Bot />}
          title="Couldn't load your crew"
          body={loadError}
          action={<Button onClick={() => void fetchCrew()}>Try again</Button>}
        />
      ) : selected ? (
        <div className="space-y-4">
          <section className="rounded-2xl border border-line bg-paper-raised p-5">
            <div className="flex flex-wrap items-start gap-4">
              <CrewAvatar member={selected} size={72} shading="fabric" />
              <div className="min-w-0 flex-1">
                <h2 className="text-[14px] font-semibold text-ink">Instructions</h2>
                <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft">{selected.instructions}</p>
              </div>
              <OverflowMenu
                label={`Actions for ${selected.name}`}
                items={[
                  { label: "Edit", icon: <Pencil />, onSelect: () => setEditor({ member: selected }) },
                  { label: "Remove", icon: <Trash2 />, danger: true, onSelect: () => void remove(selected) },
                ]}
              />
            </div>
          </section>
          <section className="rounded-2xl border border-line bg-paper-raised p-5">
            <h2 className="text-[13px] font-semibold text-ink">App access</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {selected.apps.length === 0 ? (
                <Badge>All connected apps</Badge>
              ) : selected.apps.map((app) => <Badge key={app}>{app}</Badge>)}
            </div>
            <p className="mt-4 text-[12px] text-ink-muted">
              Used in {chatSummaries.filter((chat) => chat.crew_id === selected.id).length} chats and {scheduledTasks.filter((task) => task.crew_id === selected.id).length} scheduled tasks.
            </p>
          </section>
        </div>
      ) : crew.length === 0 ? (
        <EmptyState
          icon={<Bot />}
          title="No crew members yet"
          body="Add a member with a clear job, then choose them in a chat or scheduled task."
          action={newMember}
        />
      ) : (
        <CardGrid>
          {crew.map((member) => (
            <Card
              key={member.id}
              icon={<CrewAvatar member={member} size={48} />}
              title={member.name}
              description={member.instructions}
              footer={<span>{member.apps.length === 0 ? "All connected apps" : `${member.apps.length} allowed apps`}</span>}
              onClick={() => setSelectedId(member.id)}
              menu={
                <OverflowMenu
                  label={`Actions for ${member.name}`}
                  items={[
                    { label: "New chat", icon: <MessageSquarePlus />, onSelect: () => startChat(member) },
                    { label: "Edit", icon: <Pencil />, onSelect: () => setEditor({ member }) },
                    { label: "Remove", icon: <Trash2 />, danger: true, onSelect: () => void remove(member) },
                  ]}
                />
              }
            />
          ))}
        </CardGrid>
      )}

      {actionError && <p role="alert" className="mt-4 text-[13px] text-error">{actionError}</p>}
      {editor && (
        <CrewEditor
          key={editor.member?.id ?? "new"}
          member={editor.member}
          onClose={() => setEditor(null)}
          onSaved={(member) => setSelectedId(member.id)}
        />
      )}
      {confirmDialog}
    </PageShell>
  );
}
