// Official brand marks fetched from Simple Icons CDN via jsDelivr.
// See: https://github.com/simple-icons/simple-icons
//
// SVGs are rendered via CSS mask + currentColor so they inherit the
// brand colour from the parent element's `color` CSS property.

interface LogoProps {
  className?: string;
  size?: number;
}

const SI_CDN_BASE = "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons";

const APP_SLUGS: Record<string, string> = {
  gmail: "gmail",
  googlecalendar: "googlecalendar",
  notion: "notion",
  googledrive: "googledrive",
  github: "github",
  linear: "linear",
};

export function AppBrandLogo({ appId, className, size = 24 }: { appId: string } & LogoProps) {
  const slug = APP_SLUGS[appId];
  if (!slug) return null;

  const url = `${SI_CDN_BASE}/${slug}.svg`;

  return (
    <span
      className={className}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        backgroundColor: "currentColor",
        WebkitMaskImage: `url(${url})`,
        WebkitMaskSize: "contain",
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskImage: `url(${url})`,
        maskSize: "contain",
        maskRepeat: "no-repeat",
        maskPosition: "center",
      }}
      aria-hidden="true"
    />
  );
}

export function hasBrandLogo(appId: string): boolean {
  return appId in APP_SLUGS;
}
