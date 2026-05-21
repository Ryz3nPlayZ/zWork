import "./LightRays.css";

type RaysOrigin =
  | "top-center"
  | "top-left"
  | "top-right"
  | "right"
  | "left"
  | "bottom-center"
  | "bottom-right"
  | "bottom-left";

interface LightRaysProps {
  raysOrigin?: RaysOrigin;
  raysColor?: string;
  raysSpeed?: number;
  lightSpread?: number;
  rayLength?: number;
  pulsating?: boolean;
  fadeDistance?: number;
  saturation?: number;
  followMouse?: boolean;
  mouseInfluence?: number;
  noiseAmount?: number;
  distortion?: number;
  className?: string;
}

const DEFAULT_COLOR = "#ffffff";

/* ------------------------------------------------------------------ *
 *  CSS gradient light rays — always used (WebGL path removed to
 *  eliminate CPU spikes from software-rendered WebKit webviews).
 * ------------------------------------------------------------------ */

function originToGradientPosition(origin: RaysOrigin): string {
  switch (origin) {
    case "top-left":
      return "0% 0%";
    case "top-right":
      return "100% 0%";
    case "left":
      return "0% 50%";
    case "right":
      return "100% 50%";
    case "bottom-left":
      return "0% 100%";
    case "bottom-center":
      return "50% 100%";
    case "bottom-right":
      return "100% 100%";
    default:
      return "50% 0%";
  }
}

function originToGradientShape(origin: RaysOrigin): string {
  switch (origin) {
    case "top-center":
    case "bottom-center":
      return "ellipse 100% 80%";
    case "left":
    case "right":
      return "ellipse 80% 100%";
    default:
      return "ellipse 80% 80%";
  }
}

export default function LightRays({
  raysOrigin = "top-center",
  raysColor = DEFAULT_COLOR,
  className = "",
}: LightRaysProps) {
  const position = originToGradientPosition(raysOrigin);
  const shape = originToGradientShape(raysOrigin);
  const secondaryPosition =
    raysOrigin === "top-center"
      ? "70% 20%"
      : raysOrigin === "left"
        ? "20% 60%"
        : raysOrigin === "bottom-center"
          ? "30% 80%"
          : position;

  return (
    <div
      className={`light-rays-container ${className}`.trim()}
      style={{
        background: `${shape} at ${position}, ${raysColor}0d 0%, transparent 55%,
                     ${shape} at ${secondaryPosition}, ${raysColor}08 0%, transparent 50%`,
      }}
    />
  );
}
