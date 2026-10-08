import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { cn } from "../lib/cn";
import { Logo } from "./Logo";

type LogoParticlesProps = {
  size?: number;
  particleCount?: number;
  pointScale?: number;
  spinSpeed?: number;
  className?: string;
  /** When true, the container fills its parent instead of using a fixed pixel square. */
  fill?: boolean;
};

type SampledCloud = {
  positions: Float32Array;
  phases: Float32Array;
  seeds: Float32Array;
  sizes: Float32Array;
  drifts: Float32Array;
  spins: Float32Array;
  glow: Float32Array;
};

const sampledCloudCache = new Map<number, Promise<SampledCloud>>();

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function getSampledCloud(count: number): Promise<SampledCloud> {
  const normalizedCount = Math.max(900, Math.min(count, 16000));
  const cached = sampledCloudCache.get(normalizedCount);
  if (cached) return cached;

  const promise = sampleLogoCloud(normalizedCount);
  sampledCloudCache.set(normalizedCount, promise);
  return promise;
}

function createLogoSvgMarkup(fill: string): string {
  const slats = 6;
  const radius = 12.5;
  const width = 4.2;
  const height = 11;
  const skew = -18;
  const rx = 1.6;

  const blades = Array.from({ length: slats }, (_, index) => {
    const angle = (360 / slats) * index;
    return `
      <g transform="rotate(${angle}) translate(0 -${radius})">
        <rect
          x="${-width / 2}"
          y="${-height / 2}"
          width="${width}"
          height="${height}"
          rx="${rx}"
          transform="skewX(${skew})"
        />
      </g>
    `;
  }).join("");

  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none">
      <g fill="${fill}" transform="translate(20 20)">
        ${blades}
      </g>
    </svg>
  `;
}

async function loadSvgImage(svgMarkup: string): Promise<HTMLImageElement> {
  const blob = new Blob([svgMarkup], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);

  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;

    if (typeof image.decode === "function") {
      await image.decode();
      return image;
    }

    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Failed to decode logo SVG."));
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function sampleLogoCloud(count: number): Promise<SampledCloud> {
  const sampleSize = 420;
  const svg = createLogoSvgMarkup("#000");
  const image = await loadSvgImage(svg);
  const canvas = document.createElement("canvas");
  canvas.width = sampleSize;
  canvas.height = sampleSize;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not create canvas context for logo sampling.");

  ctx.clearRect(0, 0, sampleSize, sampleSize);
  ctx.drawImage(image, 0, 0, sampleSize, sampleSize);

  const { data } = ctx.getImageData(0, 0, sampleSize, sampleSize);
  const opaque: Array<{ x: number; y: number; alpha: number }> = [];

  let minX = sampleSize;
  let minY = sampleSize;
  let maxX = 0;
  let maxY = 0;

  for (let y = 0; y < sampleSize; y += 1) {
    for (let x = 0; x < sampleSize; x += 1) {
      const alpha = data[(y * sampleSize + x) * 4 + 3];
      if (alpha < 10) continue;
      opaque.push({ x, y, alpha });
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (opaque.length === 0) {
    throw new Error("Logo SVG sampling returned no opaque pixels.");
  }

  const centerX = (minX + maxX) * 0.5;
  const centerY = (minY + maxY) * 0.5;
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const scale = 2.08;

  const positions = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const seeds = new Float32Array(count);
  const sizes = new Float32Array(count);
  const drifts = new Float32Array(count);
  const spins = new Float32Array(count);
  const glow = new Float32Array(count);

  for (let index = 0; index < count; index += 1) {
    const sample = opaque[(Math.random() * opaque.length) | 0];
    const px = ((sample.x - centerX) / span) * scale;
    const py = (-(sample.y - centerY) / span) * scale;
    const jitter = ((Math.random() - 0.5) / span) * 3.6;
    const radial = Math.hypot(px, py);
    const seed = Math.random();
    const edgeGlow = sample.alpha / 255;

    positions[index * 3 + 0] = px + jitter;
    positions[index * 3 + 1] = py + jitter;
    positions[index * 3 + 2] = (Math.random() - 0.5) * (0.05 + radial * 0.035);
    phases[index] = Math.random() * Math.PI * 2;
    seeds[index] = seed;
    sizes[index] = 0.8 + Math.random() * 1.15 + edgeGlow * 0.35;
    drifts[index] = 0.004 + Math.random() * 0.012 + radial * 0.0025;
    spins[index] = 0.4 + Math.random() * 0.85;
    glow[index] = 0.5 + edgeGlow * 0.4;
  }

  return { positions, phases, seeds, sizes, drifts, spins, glow };
}

export function LogoParticles({
  size = 640,
  particleCount = 8600,
  pointScale = 1.5,
  spinSpeed = 0.00052,
  className,
  fill = false,
}: LogoParticlesProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [renderFailed, setRenderFailed] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    setRenderFailed(false);

    let cancelled = false;
    let renderer: THREE.WebGLRenderer | null = null;
    let scene: THREE.Scene | null = null;
    let camera: THREE.PerspectiveCamera | null = null;
    let geometry: THREE.BufferGeometry | null = null;
    let material: THREE.ShaderMaterial | null = null;
    let points: THREE.Points | null = null;
    let spinGroup: THREE.Group | null = null;
    let themeObs: MutationObserver | null = null;
    let resizeObs: ResizeObserver | null = null;
    let timer: THREE.Timer | null = null;
    let onContextLost: ((e: Event) => void) | null = null;
    let bootTimer = 0;
    let raf = 0;

    const measureBounds = () => {
      const width = fill
        ? Math.max(
            mount.clientWidth,
            mount.getBoundingClientRect().width,
            window.innerWidth,
            1,
          )
        : size;
      const height = fill
        ? Math.max(
            mount.clientHeight,
            mount.getBoundingClientRect().height,
            window.innerHeight,
            1,
          )
        : size;
      return {
        width: Math.round(width),
        height: Math.round(height),
      };
    };

    const boot = async () => {
      try {
        const reducedMotion = prefersReducedMotion();
        const effectiveParticleCount = reducedMotion
          ? Math.max(1800, Math.round(particleCount * 0.45))
          : particleCount;
        const cloud = await getSampledCloud(effectiveParticleCount);
        if (cancelled || !mount) return;

        const dpr = Math.min(window.devicePixelRatio || 1, fill ? 1.35 : 1.75);
        const { width: w, height: h } = measureBounds();
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "high-performance" });
        renderer.setPixelRatio(dpr);
        renderer.setSize(w, h, false);
        renderer.setClearColor(0x000000, 0);
        renderer.domElement.style.width = "100%";
        renderer.domElement.style.height = "100%";
        renderer.domElement.style.display = "block";

        onContextLost = (e: Event) => {
          e.preventDefault();
          if (!cancelled) setRenderFailed(true);
          cancelled = true;
        };
        renderer.domElement.addEventListener("webglcontextlost", onContextLost);

        mount.appendChild(renderer.domElement);

        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(28, w / h, 0.01, 10);
        camera.position.set(0, 0, 2.78);
        camera.lookAt(0, 0, 0);

        geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.BufferAttribute(cloud.positions, 3),
        );
        geometry.setAttribute(
          "aPhase",
          new THREE.BufferAttribute(cloud.phases, 1),
        );
        geometry.setAttribute(
          "aSeed",
          new THREE.BufferAttribute(cloud.seeds, 1),
        );
        geometry.setAttribute(
          "aSize",
          new THREE.BufferAttribute(cloud.sizes, 1),
        );
        geometry.setAttribute(
          "aDrift",
          new THREE.BufferAttribute(cloud.drifts, 1),
        );
        geometry.setAttribute(
          "aSpin",
          new THREE.BufferAttribute(cloud.spins, 1),
        );
        geometry.setAttribute(
          "aGlow",
          new THREE.BufferAttribute(cloud.glow, 1),
        );

        const isDark = () =>
          document.documentElement.classList.contains("dark");
        const uniforms: Record<string, THREE.IUniform> = {
          uTime: { value: 0 },
          uColor: {
            value: isDark()
              ? new THREE.Color(0xececea)
              : new THREE.Color(0x171716),
          },
          uPointScale: { value: dpr * 1.9 * pointScale * (reducedMotion ? 0.9 : 1) },
        };

        material = new THREE.ShaderMaterial({
          uniforms,
          transparent: true,
          depthWrite: false,
          blending: THREE.NormalBlending,
          vertexShader: /* glsl */ `
            uniform float uTime;
            uniform float uPointScale;

            attribute float aPhase;
            attribute float aSeed;
            attribute float aSize;
            attribute float aDrift;
            attribute float aSpin;
            attribute float aGlow;

            varying float vAlpha;

            void main() {
              vec3 p = position;
              float t = uTime;
              float driftAngle = (t * aSpin) + aPhase;

              p.x += cos(driftAngle) * aDrift;
              p.y += sin(driftAngle) * aDrift;
              p.z += 0.02 * sin((t * 0.82) + (aSeed * 6.2831853));

              vAlpha = aGlow * (0.7 + 0.3 * sin((t * 1.1) + (aPhase * 1.35)));

              vec4 mv = modelViewMatrix * vec4(p, 1.0);
              gl_Position = projectionMatrix * mv;
              gl_PointSize = max(1.0, uPointScale * aSize * (2.4 / -mv.z));
            }
          `,
          fragmentShader: /* glsl */ `
            uniform vec3 uColor;
            varying float vAlpha;

            void main() {
              vec2 uv = gl_PointCoord - 0.5;
              float r = length(uv);
              float a = 1.0 - smoothstep(0.12, 0.5, r);
              if (a < 0.01) discard;
              gl_FragColor = vec4(uColor, a * vAlpha);
            }
          `,
        });

        points = new THREE.Points(geometry, material);
        spinGroup = new THREE.Group();
        spinGroup.add(points);
        scene.add(spinGroup);

        themeObs = new MutationObserver(() => {
          (uniforms.uColor.value as THREE.Color).set(
            isDark() ? 0xececea : 0x171716,
          );
        });
        themeObs.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class"],
        });

        timer = new THREE.Timer();
        timer.connect(document);
        const angularVelocity = spinSpeed * 165 * (reducedMotion ? 0.38 : 1);
        const resize = () => {
          if (!fill || !mount || !renderer || !camera) return;
          const { width, height } = measureBounds();
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          renderer.setSize(width, height, false);
        };

        resizeObs =
          fill && "ResizeObserver" in window ? new ResizeObserver(resize) : null;
        resizeObs?.observe(mount);
        resize();

        const tick = () => {
          if (
            cancelled ||
            !timer ||
            !renderer ||
            !scene ||
            !camera ||
            !spinGroup
          ) {
            return;
          }

          timer.update();
          const elapsed = timer.getElapsed();
          uniforms.uTime.value = elapsed;
          spinGroup.rotation.z = elapsed * angularVelocity;
          renderer.render(scene, camera);
          raf = requestAnimationFrame(tick);
        };

        raf = requestAnimationFrame(tick);
      } catch {
        if (!cancelled) setRenderFailed(true);
      }
    };

    bootTimer = window.setTimeout(() => {
      void boot();
    }, 40);

    return () => {
      cancelled = true;
      window.clearTimeout(bootTimer);
      cancelAnimationFrame(raf);
      themeObs?.disconnect();
      resizeObs?.disconnect();
      timer?.dispose();
      geometry?.dispose();
      material?.dispose();
      if (renderer && onContextLost) {
        renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      }
      renderer?.dispose();
      if (renderer?.domElement?.parentElement === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, [particleCount, pointScale, size, spinSpeed]);

  return (
    <div
      ref={mountRef}
      className={cn("relative", fill ? "absolute inset-0" : "shrink-0", className)}
      style={fill ? undefined : { width: size, height: size }}
      aria-hidden="true"
    >
      {renderFailed && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-75">
          <Logo size={Math.max(22, Math.round(Math.min(size, 200) * 0.58))} className="text-ink/70" />
        </div>
      )}
    </div>
  );
}
