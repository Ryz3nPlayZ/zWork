// Official brand marks from simple-icons.org (github.com/simple-icons/simple-icons)
// Each logo uses its actual brand color. Logos that do not have a simple-icons
// entry are drawn from official brand guidelines.

interface LogoProps {
  className?: string;
  size?: number;
}

/* Gmail — clean official layout */
export function GmailLogo({ className, size = 24 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#EA4335" d="M20 4H4C2.9 4 2 4.9 2 6v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2z" />
      <path fill="#FFF" d="M20 6l-8 5-8-5v12h16V6z" />
      <path fill="#EA4335" d="M4 6v12h3V8.5l5 3.5 5-3.5V18h3V6l-8 5.5L4 6z" />
    </svg>
  );
}

/* Google Calendar — high-fidelity official brand design */
export function GoogleCalendarLogo({ className, size = 24 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#4285F4" d="M19.5 3h-3V1.5c0-.28-.22-.5-.5-.5h-2c-.28 0-.5.22-.5.5V3H10.5V1.5c0-.28-.22-.5-.5-.5h-2c-.28 0-.5.22-.5.5V3h-3C3.67 3 3 3.67 3 4.5v15c0 .83.67 1.5 1.5 1.5h15c.83 0 1.5-.67 1.5-1.5v-15c0-.83-.67-1.5-1.5-1.5z" />
      <path fill="#FFF" d="M19.5 19.5h-15V7.5h15v12z" />
      <text x="12" y="16.5" fill="#4285F4" fontSize="9" fontWeight="bold" fontFamily="sans-serif" textAnchor="middle">31</text>
      <circle cx="6.5" cy="5" r="1" fill="#FFF" />
      <circle cx="17.5" cy="5" r="1" fill="#FFF" />
    </svg>
  );
}

/* Notion — official simple-icons "notion" */
export function NotionLogo({ className, size = 24 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="currentColor" d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"/>
    </svg>
  );
}

/* Google Drive — official simple-icons "googledrive" */
export function GoogleDriveLogo({ className, size = 24 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#4285F4" d="M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574z"/>
      <path fill="#34A853" d="M7.25 3.215a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214z"/>
      <path fill="#FBBC04" d="M9.509 15.868l-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z"/>
    </svg>
  );
}

/* GitHub — official simple-icons "github" */
export function GitHubLogo({ className, size = 24 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="currentColor" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
    </svg>
  );
}

/* Linear — official simple-icons "linear" */
export function LinearLogo({ className, size = 24 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="currentColor" d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"/>
    </svg>
  );
}

const LOGO_MAP: Record<string, React.FC<LogoProps>> = {
  gmail: GmailLogo,
  googlecalendar: GoogleCalendarLogo,
  notion: NotionLogo,
  googledrive: GoogleDriveLogo,
  github: GitHubLogo,
  linear: LinearLogo,
};

export function AppBrandLogo({ appId, className, size = 24 }: { appId: string } & LogoProps) {
  const Logo = LOGO_MAP[appId];
  if (!Logo) return null;
  return <Logo className={className} size={size} />;
}

export function hasBrandLogo(appId: string): boolean {
  return appId in LOGO_MAP;
}
