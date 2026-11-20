import { useEffect, useRef, useState } from "react";
import { useMicrophone } from "voice-glow";

// The Web Speech API has no lib.dom types; WebKit only ships the prefixed name.
const SpeechCtor: any =
  typeof window !== "undefined" ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;

/** False in WebView2 (Windows) and older browsers; the mic button is hidden there. */
export const dictationSupported = !!SpeechCtor;

/** "mic" = microphone blocked; "speech" = speech recognition turned off for the app. */
export type DictationBlock = "mic" | "speech" | null;

/**
 * Speech-to-text into the composer. Words land in the text as they are heard
 * (after whatever was already typed) and stay there when listening stops;
 * nothing is sent. The mic stream only feeds the glow.
 */
export function useDictation(getText: () => string, setText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [blocked, setBlocked] = useState<DictationBlock>(null);
  const recRef = useRef<any>(null);
  const mic = useMicrophone();
  const io = useRef({ getText, setText });
  io.current = { getText, setText };

  const stop = () => {
    recRef.current?.stop();
    mic.stop();
  };

  // Must run inside the click (or key) handler: the mic needs a user gesture.
  const start = () => {
    if (!SpeechCtor || recRef.current) return;
    setBlocked(null);
    const rec = new SpeechCtor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    const typed = io.current.getText().trimEnd();
    const lead = typed ? `${typed} ` : "";
    rec.onresult = (e: any) => {
      let said = "";
      for (let i = 0; i < e.results.length; i++) said += e.results[i][0].transcript;
      io.current.setText(lead + said.trimStart());
    };
    rec.onerror = (e: any) => {
      // "no-speech" and "aborted" just end quietly.
      if (e.error === "not-allowed") setBlocked("mic");
      else if (e.error === "service-not-allowed") setBlocked("speech");
    };
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
      mic.stop();
    };
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
      void mic.start(); // glow only; if it fails the beam just breathes
    } catch {
      recRef.current = null;
    }
  };

  useEffect(() => () => recRef.current?.abort(), []);

  return { listening, blocked, stream: mic.stream, start, stop, dismissBlocked: () => setBlocked(null) };
}
