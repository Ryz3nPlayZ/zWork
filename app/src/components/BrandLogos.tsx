// Official brand marks fetched from Simple Icons CDN via jsDelivr.
// See: https://github.com/simple-icons/simple-icons

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
  return (
    <img
      src={`${SI_CDN_BASE}/${slug}.svg`}
      alt=""
      width={size}
      height={size}
      className={className}
      style={{ display: "block" }}
      aria-hidden="true"
    />
  );
}

export function hasBrandLogo(appId: string): boolean {
  return appId in APP_SLUGS;
}
