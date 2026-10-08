import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "../lib/cn";
import { useApp } from "../lib/store";
import { isMacOS } from "../lib/platform";
import { IconButton } from "./IconButton";
import { ArtifactCodeViewer } from "./artifacts/ArtifactCodeViewer";
import { ArtifactDocViewer } from "./artifacts/ArtifactDocViewer";
import { ArtifactGraphViewer } from "./artifacts/ArtifactGraphViewer";
import { ArtifactPreviewViewer } from "./artifacts/ArtifactPreviewViewer";
import { ArtifactSheetViewer } from "./artifacts/ArtifactSheetViewer";

export function ArtifactPanel() {
  const macOS = isMacOS();
  const activeChatId = useApp((s) => s.activeChatId);
  const open = useApp((s) => {
    const chatId = s.activeChatId;
    return chatId ? !!s.chats[chatId]?.artifactPanelOpen : false;
  });
  const artifacts = useApp((s) => s.artifacts);
  const close = useApp((s) => s.closeArtifactPanel);
  const updateArtifact = useApp((s) => s.updateArtifact);

  const activeChat = useApp((s) => (s.activeChatId ? s.chats[s.activeChatId] : null));
  const active = artifacts.find((a) => a.id === activeChat?.activeArtifactId) ?? null;
  const [draftTitle, setDraftTitle] = useState(active?.title ?? "");

  useEffect(() => {
    setDraftTitle(active?.title ?? "");
  }, [active?.id, active?.title]);

  return (
    <AnimatePresence>
      {open && activeChatId && active && (
        <motion.aside
          key="artifact-panel"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: "clamp(420px, 46vw, 760px)", opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="h-full shrink-0 overflow-hidden border-l border-line bg-paper"
        >
          <div className="flex h-full flex-col">
            <div className={cn(macOS && "titlebar-drag", "flex h-12 shrink-0 items-center justify-between border-b border-line px-3")}>
              <div className="min-w-0 flex-1" data-no-drag>
                <input
                  value={draftTitle}
                  onChange={(e) => {
                    const next = e.target.value;
                    setDraftTitle(next);
                    updateArtifact(active.id, { title: next });
                  }}
                  className="min-w-0 w-full rounded-md border border-transparent bg-transparent px-1 py-1 text-[13px] font-medium text-ink focus:border-line-strong focus:bg-paper-sunken focus:outline-none"
                />
              </div>
              <div className="flex items-center gap-2" data-no-drag>
                <IconButton icon={<X />} label="Close artifact" size="sm" onClick={close} />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {active.kind === "doc" ? (
                <ArtifactDocViewer artifact={active} />
              ) : active.kind === "sheet" ? (
                <ArtifactSheetViewer artifact={active} />
              ) : active.kind === "graph" ? (
                <ArtifactGraphViewer artifact={active} />
              ) : active.kind === "preview" ? (
                <ArtifactPreviewViewer artifact={active} />
              ) : (
                <ArtifactCodeViewer artifact={active} />
              )}
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
