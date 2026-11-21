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
 * nothing is sent. The mic only feeds the glow's `level`.
 */
export function useDictation(getText: () => string, setText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [blocked, setBlocked] = useState<DictationBlock>(null);
  const recRef = useRef<any>(null);
  const mic = useMicrophone();
  const audio = useRef<AudioContext | null>(null);
  const meter = useRef<{ an: AnalyserNode; buf: Float32Array<ArrayBuffer> } | null>(null);
  const lastHeard = useRef(0);
  const io = useRef({ getText, setText });
  io.current = { getText, setText };

  const stop = () => {
    recRef.current?.stop();
    mic.stop();
  };

  useEffect(() => {
    const ctx = audio.current;
    if (!mic.stream || !ctx) return;
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    const src = ctx.createMediaStreamSource(mic.stream);
    src.connect(an);
    meter.current = { an, buf: new Float32Array(an.fftSize) };
    return () => {
      src.disconnect();
      meter.current = null;
    };
  }, [mic.stream]);

  // 0–1 for the glow, read every frame: the mic's loudness, or failing that
  // (WebKit can hand back a silent track while recognition holds the mic)
  // a pulse each time new words are recognised.
  const level = () => {
    let rms = 0;
    const m = meter.current;
    if (m) {
      m.an.getFloatTimeDomainData(m.buf);
      for (const v of m.buf) rms += v * v;
      rms = Math.sqrt(rms / m.buf.length);
    }
    const heard = Math.max(0, 0.75 - (performance.now() - lastHeard.current) / 900);
    return Math.min(1, Math.max(rms * 10, heard));
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
      lastHeard.current = performance.now();
      // WebKit's segments don't carry the space between them ("HelloWhat can you do").
      const parts: string[] = [];
      for (let i = 0; i < e.results.length; i++) parts.push(e.results[i][0].transcript.trim());
      io.current.setText(lead + parts.filter(Boolean).join(" "));
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
      // Made inside the gesture so WebKit doesn't leave it suspended.
      audio.current ??= new AudioContext();
      void audio.current.resume();
      rec.start();
      setListening(true);
      void mic.start(); // glow only; if it fails, recognised words still pulse it
    } catch {
      recRef.current = null;
    }
  };

  useEffect(
    () => () => {
      recRef.current?.abort();
      void audio.current?.close();
    },
    [],
  );

  return { listening, blocked, level, start, stop, dismissBlocked: () => setBlocked(null) };
}
