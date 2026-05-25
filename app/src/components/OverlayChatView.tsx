import { useEffect, useRef, useState } from "react";
import { Monitor, Mic, MicOff, Send, X, Loader2, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { streamChat } from "../lib/api";
import { cn } from "../lib/cn";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  screenshot?: string; // base64 representation if attached
}

export function OverlayChatView() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "Hello! I'm your zWork Overlay assistant. Use Alt+Space to toggle me, or click below to show me your screen.",
    },
  ]);
  const [inputValue, setInputValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [screenshotBase64, setScreenshotBase64] = useState<string | null>(null);
  const [screenshotLoading, setScreenshotLoading] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Set up Speech Recognition (Web Speech API)
  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const rec = new SpeechRecognition();
      rec.continuous = false;
      rec.interimResults = false;
      rec.lang = "en-US";

      rec.onstart = () => {
        setIsRecording(true);
      };

      rec.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        if (transcript) {
          setInputValue((prev) => (prev ? `${prev} ${transcript}` : transcript));
        }
      };

      rec.onerror = (e: any) => {
        console.error("Speech recognition error:", e);
        setIsRecording(false);
      };

      rec.onend = () => {
        setIsRecording(false);
      };

      recognitionRef.current = rec;
    }
  }, []);

  const toggleRecording = () => {
    if (!recognitionRef.current) {
      alert("Speech recognition is not supported in this environment.");
      return;
    }
    if (isRecording) {
      recognitionRef.current.stop();
    } else {
      recognitionRef.current.start();
    }
  };

  // Close overlay window natively via Tauri
  const closeWindow = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().hide();
    } catch (err) {
      console.error("Failed to hide window", err);
    }
  };

  // Capture screen using dctl via sidecar API
  const handleCaptureScreen = async () => {
    setScreenshotLoading(true);
    try {
      const resp = await api.captureScreenshot();
      if (resp.screenshot) {
        setScreenshotBase64(resp.screenshot);
      } else if (resp.error) {
        console.error("Screenshot error:", resp.error);
      }
    } catch (err) {
      console.error("Failed to capture screen:", err);
    } finally {
      setScreenshotLoading(false);
    }
  };

  // Send message
  const handleSend = async () => {
    if (!inputValue.trim() && !screenshotBase64) return;

    const userMessageText = inputValue.trim();
    const currentScreenshot = screenshotBase64;

    // Reset inputs
    setInputValue("");
    setScreenshotBase64(null);

    const userMsgId = Math.random().toString(36).substring(7);
    const assistantMsgId = Math.random().toString(36).substring(7);

    // Add user message to list
    setMessages((prev) => [
      ...prev,
      {
        id: userMsgId,
        role: "user",
        content: userMessageText || "Attached screenshot",
        screenshot: currentScreenshot || undefined,
      },
    ]);

    setLoading(true);

    try {
      let attachments: any[] = [];
      if (currentScreenshot) {
        // Upload the captured screenshot to the backend
        const uploadResp = await api.uploadFiles([
          {
            name: "screenshot.png",
            mime: "image/png",
            kind: "image",
            data_url: `data:image/png;base64,${currentScreenshot}`,
          },
        ]);
        if (uploadResp.files && uploadResp.files.length > 0) {
          attachments = [
            {
              name: "screenshot.png",
              path: uploadResp.files[0].path,
              mime: "image/png",
              kind: "image",
            },
          ];
        }
      }

      // Add placeholder for assistant response
      setMessages((prev) => [
        ...prev,
        {
          id: assistantMsgId,
          role: "assistant",
          content: "",
        },
      ]);

      let streamingText = "";
      await streamChat(
        {
          message: userMessageText || "What is on my screen?",
          attachments,
        },
        (event) => {
          if (event.type === "delta" && event.text) {
            streamingText += event.text;
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMsgId ? { ...msg, content: streamingText } : msg
              )
            );
          }
        }
      );
    } catch (err) {
      console.error("Chat streaming failed:", err);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId
            ? { ...msg, content: "Sorry, I encountered an error connecting to the model." }
            : msg
        )
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-paper/75 backdrop-blur-xl border border-line/20 rounded-3xl shadow-2xl p-4 select-none text-ink">
      {/* Drag & Header region */}
      <div
        data-tauri-drag-region
        className="flex items-center justify-between pb-3 border-b border-line/20 cursor-move"
      >
        <div className="flex items-center gap-2 pointer-events-none">
          <div className="p-1.5 rounded-lg bg-accent/10">
            <Sparkles className="h-4.5 w-4.5 text-accent animate-pulse" />
          </div>
          <div>
            <h2 className="text-[13px] font-semibold tracking-tight text-ink">zWork Screen Sight</h2>
            <p className="text-[10px] text-ink-muted">Glass Chat Overlay</p>
          </div>
        </div>

        <button
          type="button"
          onClick={closeWindow}
          className="press p-1.5 rounded-full hover:bg-paper-sunken text-ink-muted hover:text-ink transition-colors"
          aria-label="Hide Overlay"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto py-4 px-1 space-y-4 min-h-0 scrollbar-thin">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              "flex flex-col max-w-[85%] rounded-2xl p-3 text-[12.5px] leading-relaxed shadow-sm",
              msg.role === "user"
                ? "ml-auto bg-accent text-paper"
                : "bg-paper-raised text-ink border border-line/30"
            )}
          >
            {msg.screenshot && (
              <img
                src={`data:image/png;base64,${msg.screenshot}`}
                alt="Captured screen context"
                className="rounded-lg mb-2 max-h-[140px] object-contain border border-line/20"
              />
            )}
            <div className="whitespace-pre-wrap">{msg.content}</div>
          </div>
        ))}
        {loading && messages[messages.length - 1]?.content === "" && (
          <div className="bg-paper-raised text-ink border border-line/30 rounded-2xl p-3 max-w-[85%] mr-auto flex items-center gap-2 text-[12px]">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-muted" />
            <span>Analyzing...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Screenshot Preview */}
      {screenshotBase64 && (
        <div className="relative inline-block self-start mb-3 p-1 bg-paper-raised border border-line rounded-xl">
          <img
            src={`data:image/png;base64,${screenshotBase64}`}
            alt="Screen attachment preview"
            className="h-14 w-auto rounded-lg object-contain"
          />
          <button
            type="button"
            onClick={() => setScreenshotBase64(null)}
            className="absolute -top-1.5 -right-1.5 p-0.5 rounded-full bg-ink text-paper hover:bg-ink/80"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Input area */}
      <div className="flex items-center gap-2 bg-paper-raised/80 border border-line/50 rounded-2xl p-2 focus-within:ring-2 focus-within:ring-accent/20">
        <button
          type="button"
          onClick={handleCaptureScreen}
          disabled={screenshotLoading}
          className={cn(
            "press p-2 rounded-xl text-ink-muted hover:text-ink hover:bg-paper-sunken transition-all",
            screenshotLoading && "opacity-50"
          )}
          title="Sight: Screen Capture"
          aria-label="Capture screen"
        >
          {screenshotLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Monitor className="h-4 w-4" />
          )}
        </button>

        <button
          type="button"
          onClick={toggleRecording}
          className={cn(
            "press p-2 rounded-xl transition-all",
            isRecording
              ? "bg-red-500/10 text-red-500 animate-pulse"
              : "text-ink-muted hover:text-ink hover:bg-paper-sunken"
          )}
          title="Voice note dictation"
          aria-label="Toggle voice recording"
        >
          {isRecording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </button>

        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder={isRecording ? "Listening..." : "Ask me anything..."}
          className="flex-1 bg-transparent border-none text-[12.5px] outline-none text-ink placeholder-ink-muted/65 min-w-0"
        />

        <button
          type="button"
          onClick={handleSend}
          disabled={loading || (!inputValue.trim() && !screenshotBase64)}
          className={cn(
            "press p-2 rounded-xl bg-accent text-paper hover:opacity-90 disabled:opacity-30 disabled:pointer-events-none transition-all"
          )}
          aria-label="Send message"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
