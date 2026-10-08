import { useState, useEffect, useCallback } from "react";
import type { DemoScenario } from "../../demos/types";

export type DemoPhase =
  | "idle"
  | "typing"
  | "sent"
  | "thinking"
  | "done"
  | "artifact"
  | "complete";

interface DemoState {
  phase: DemoPhase;
  typedText: string;
  visibleActivities: number;
  showArtifact: boolean;
}

export function useDemoScenario(
  scenario: DemoScenario,
  options: {
    autoStart?: boolean;
    typingSpeed?: number;
    stepDelay?: number;
    doneDelay?: number;
    artifactDelay?: number;
    loopDelay?: number;
  } = {}
) {
  const {
    autoStart = true,
    typingSpeed = 40,
    stepDelay = 1000,
    doneDelay = 600,
    artifactDelay = 400,
    loopDelay = 3000,
  } = options;

  const [state, setState] = useState<DemoState>({
    phase: "idle",
    typedText: "",
    visibleActivities: 0,
    showArtifact: false,
  });

  const reset = useCallback(() => {
    setState({
      phase: "idle",
      typedText: "",
      visibleActivities: 0,
      showArtifact: false,
    });
  }, []);

  const start = useCallback(() => {
    reset();
    setTimeout(() => {
      setState((s) => ({ ...s, phase: "typing" }));
    }, 100);
  }, [reset]);

  // Typing effect
  useEffect(() => {
    if (state.phase !== "typing") return;
    let i = 0;
    const interval = setInterval(() => {
      if (i < scenario.userMessage.length) {
        setState((s) => ({
          ...s,
          typedText: scenario.userMessage.slice(0, i + 1),
        }));
        i++;
      } else {
        clearInterval(interval);
        setTimeout(() => {
          setState((s) => ({ ...s, phase: "sent" }));
        }, 400);
      }
    }, typingSpeed);
    return () => clearInterval(interval);
  }, [state.phase, scenario.userMessage, typingSpeed]);

  // Sent -> thinking
  useEffect(() => {
    if (state.phase !== "sent") return;
    const timeout = setTimeout(() => {
      setState((s) => ({ ...s, phase: "thinking" }));
    }, doneDelay);
    return () => clearTimeout(timeout);
  }, [state.phase, doneDelay]);

  // Activity step progression
  useEffect(() => {
    if (state.phase !== "thinking") return;
    if (state.visibleActivities >= scenario.activities.length) {
      const timeout = setTimeout(() => {
        setState((s) => ({ ...s, phase: "done" }));
      }, stepDelay);
      return () => clearTimeout(timeout);
    }
    const timeout = setTimeout(() => {
      setState((s) => ({
        ...s,
        visibleActivities: s.visibleActivities + 1,
      }));
    }, stepDelay);
    return () => clearTimeout(timeout);
  }, [state.phase, state.visibleActivities, scenario.activities.length, stepDelay]);

  // Done -> artifact
  useEffect(() => {
    if (state.phase !== "done") return;
    if (!scenario.artifact) {
      const timeout = setTimeout(() => {
        setState((s) => ({ ...s, phase: "complete" }));
      }, artifactDelay);
      return () => clearTimeout(timeout);
    }
    const timeout = setTimeout(() => {
      setState((s) => ({ ...s, showArtifact: true, phase: "artifact" }));
    }, artifactDelay);
    return () => clearTimeout(timeout);
  }, [state.phase, scenario.artifact, artifactDelay]);

  // Artifact -> complete
  useEffect(() => {
    if (state.phase !== "artifact") return;
    const timeout = setTimeout(() => {
      setState((s) => ({ ...s, phase: "complete" }));
    }, stepDelay * 2);
    return () => clearTimeout(timeout);
  }, [state.phase, stepDelay]);

  // Auto-loop
  useEffect(() => {
    if (state.phase !== "complete") return;
    const timeout = setTimeout(() => {
      reset();
      setTimeout(() => {
        setState((s) => ({ ...s, phase: "typing" }));
      }, 200);
    }, loopDelay);
    return () => clearTimeout(timeout);
  }, [state.phase, loopDelay, reset]);

  // Auto-start
  useEffect(() => {
    if (autoStart && state.phase === "idle") {
      const timeout = setTimeout(() => {
        setState((s) => ({ ...s, phase: "typing" }));
      }, 600);
      return () => clearTimeout(timeout);
    }
  }, [autoStart, state.phase]);

  return { state, start, reset };
}
