import { useEffect, useState } from "react";
import { ArrowLeft, Bot, MessageSquarePlus, Pencil, Plus, Trash2 } from "lucide-react";
import { botAvatarTypes, type BotAvatarType } from "bot-avatars";
import { useApp } from "../../lib/store";
import type { CrewMember } from "../../lib/api";
import { cn } from "../../lib/cn";
import {
  Badge,
  Button,
  Card,
  CardGrid,
  Dialog,
  EmptyState,
  Field,
  OverflowMenu,
  PageShell,
  inputClass,
  useConfirm,
} from "../page/Page";
import { CrewAvatar } from "./CrewAvatar";

const COLORS = ["#d97757", "#52796f", "#6d597a", "#3a6ea5", "#b5651d", "#a44a3f"];

function CrewEditor({
  member,
  onClose,
  onSaved,
}: {
  member: CrewMember | null;
  onClose: () => void;
  onSaved: (member: CrewMember) => void;
}) {
  const createCrew = useApp((s) => s.createCrew);
  const updateCrew = useApp((s) => s.updateCrew);
  const apps = useApp((s) => s.composioApps);
  const [name, setName] = useState(member?.name ?? "");
  const [instructions, setInstructions] = useState(member?.instructions ?? "");
  const [avatar, setAvatar] = useState(member?.avatar || "clover");
  const [color, setColor] = useState(member?.color || COLORS[0]);
  const [selectedApps, setSelectedApps] = useState<string[]>(member?.apps ?? []);
  const [restrictApps, setRestrictApps] = useState((member?.apps.length ?? 0) > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const appProblem = restrictApps && selectedApps.length === 0;
  const canSave = name.trim().length > 0 && instructions.trim().length > 0 && !appProblem && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      instructions: instructions.trim(),
      avatar,
      color,
      apps: restrictApps ? selectedApps : [],
    };
    try {
      const saved = member ? await updateCrew(member.id, body) : await createCrew(body);
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={member ? `Edit ${member.name}` : "New crew member"}
      description="Give them one clear job. Their instructions and app access apply to every chat or scheduled task you assign."
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
            {busy ? "Saving…" : member ? "Save changes" : "Add member"}
          </Button>
        </>
      }
    >
      <Field label="Name" htmlFor="crew-name">
        <input
          id="crew-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Research assistant"
          className={inputClass}
        />
      </Field>

      <Field
        label="Instructions"
        htmlFor="crew-instructions"
        hint="Describe the job, the result you want, and any limits they should follow."
      >
        <textarea
          id="crew-instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={6}
          placeholder="Find relevant primary sources, compare what they say, and give me a concise summary with links."
          className={cn(inputClass, "resize-none leading-relaxed")}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Avatar" htmlFor="crew-avatar">
          <select
            id="crew-avatar"
            value={avatar}
            onChange={(e) => setAvatar(e.target.value as BotAvatarType)}
            className={inputClass}
          >
            {botAvatarTypes.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        </Field>
        <Field label="Colour">
          <div className="flex flex-wrap gap-2 pt-1" role="radiogroup" aria-label="Avatar colour">
            {COLORS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={color === value}
                aria-label={`Colour ${value}`}
                onClick={() => setColor(value)}
                className={cn(
                  "press ring-focus h-9 w-9 rounded-lg border-2 bg-paper p-1",
                  color === value ? "border-ink" : "border-line",
                )}
              >
                <span className="block h-full w-full rounded-md" style={{ backgroundColor: value }} />
              </button>
            ))}
          </div>
        </Field>
      </div>

      <Field
        label="Connected apps"
        hint={restrictApps ? "Only tools from the selected apps are available to this member." : "This member can use tools from every connected app."}
      >
        <label className="flex min-h-9 cursor-pointer items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={restrictApps}
            onChange={(e) => setRestrictApps(e.target.checked)}
            className="h-4 w-4 accent-current"
          />
          Limit which apps they can use
        </label>
        {restrictApps && (
          <div className="mt-2 grid max-h-44 gap-1 overflow-y-auto rounded-xl border border-line bg-paper p-2 sm:grid-cols-2">
            {apps.map((app) => (
              <label key={app.id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2 text-[12.5px] text-ink hover:bg-ink/5">
                <input
                  type="checkbox"
                  checked={selectedApps.includes(app.id)}
                  onChange={() =>
                    setSelectedApps((current) =>
                      current.includes(app.id) ? current.filter((id) => id !== app.id) : [...current, app.id],
                    )
                  }
                  className="h-4 w-4 accent-current"
                />
                {app.name}
              </label>
            ))}
          </div>
        )}
        {appProblem && <p className="mt-1.5 text-[11.5px] text-error">Pick at least one app, or allow all connected apps.</p>}
      </Field>

      {error && (
        <p role="alert" className="rounded-lg border border-error/25 bg-error/10 px-3 py-2 text-[12.5px] text-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}

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
