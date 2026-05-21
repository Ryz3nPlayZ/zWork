interface LogoProps {
  className?: string;
  size?: number;
}

export function GmailLogo({ className, size = 24 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M22 6.5v11c0 .8-.7 1.5-1.5 1.5h-1.5V9l-7 4.5L5 9v10H3.5c-.8 0-1.5-.7-1.5-1.5v-11c0-.7.4-1.2 1-1.4.5-.2 1.1-.1 1.5.3L12 9l7.5-4.6c.4-.4 1-.5 1.5-.3.6.2 1 .7 1 1.4z" fill="currentColor"/>
    </svg>
  );
}

export function GoogleCalendarLogo({ className, size = 24 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="2" y="4" width="20" height="18" rx="2" fill="currentColor" opacity="0.15"/>
      <path d="M2 8h20M7 2v4M17 2v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      <rect x="5" y="11" width="3" height="3" rx="0.5" fill="currentColor" opacity="0.6"/>
      <rect x="10.5" y="11" width="3" height="3" rx="0.5" fill="currentColor" opacity="0.6"/>
      <rect x="16" y="11" width="3" height="3" rx="0.5" fill="currentColor" opacity="0.6"/>
      <rect x="5" y="16" width="3" height="3" rx="0.5" fill="currentColor" opacity="0.6"/>
      <rect x="10.5" y="16" width="3" height="3" rx="0.5" fill="currentColor" opacity="0.6"/>
    </svg>
  );
}

export function SlackLogo({ className, size = 24 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" fill="currentColor"/>
    </svg>
  );
}

export function NotionLogo({ className, size = 24 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 2.03c-.42-.326-.98-.7-2.055-.607L3.01 2.745c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.166V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.934zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952l1.448.327s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.14c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" fill="currentColor"/>
    </svg>
  );
}

export function GoogleDriveLogo({ className, size = 24 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M12 2L2 19h20L12 2z" fill="currentColor" opacity="0.9"/>
      <path d="M12 2l5 9.5H7L12 2z" fill="currentColor" opacity="0.6"/>
      <path d="M7 11.5L2 19h10L7 11.5z" fill="currentColor" opacity="0.4"/>
    </svg>
  );
}

export function GitHubLogo({ className, size = 24 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.308.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" fill="currentColor"/>
    </svg>
  );
}

export function JiraLogo({ className, size = 24 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.005 1.005 0 0 0 23.013 0z" fill="currentColor"/>
    </svg>
  );
}

export function TrelloLogo({ className, size = 24 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="3" fill="currentColor" opacity="0.15"/>
      <rect x="5" y="5" width="6" height="14" rx="1.5" fill="currentColor" opacity="0.9"/>
      <rect x="13" y="5" width="6" height="9" rx="1.5" fill="currentColor" opacity="0.5"/>
    </svg>
  );
}

export function TodoistLogo({ className, size = 24 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.15"/>
      <path d="M8 12.5l2.5 2.5L16 9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  );
}

export function LinearLogo({ className, size = 24 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 9-9v9H3z" fill="currentColor" opacity="0.9"/>
      <path d="M12 3a9 9 0 0 1 9 9h-9V3z" fill="currentColor" opacity="0.5"/>
      <path d="M12 12h9a9 9 0 0 1-9 9v-9z" fill="currentColor" opacity="0.2"/>
    </svg>
  );
}

export function AsanaLogo({ className, size = 24 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="7" cy="12" r="5" fill="currentColor" opacity="0.9"/>
      <circle cx="17" cy="7" r="4" fill="currentColor" opacity="0.5"/>
      <circle cx="17" cy="17" r="4" fill="currentColor" opacity="0.5"/>
    </svg>
  );
}

export function HubSpotLogo({ className, size = 24 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M18.164 7.93V5.084a2.198 2.198 0 0 0 1.267-1.984 2.21 2.21 0 0 0-4.418 0c0 .852.49 1.59 1.2 1.96v2.869a5.476 5.476 0 0 0-3.166 1.597l-5.56-4.33a3.046 3.046 0 0 0 .12-.792 3.055 3.055 0 1 0-3.055 3.055c.766 0 1.46-.29 1.996-.756l5.445 4.24a5.493 5.493 0 0 0 .095 5.888l-2.834 2.835a2.92 2.92 0 0 0-.862-.134 2.962 2.962 0 1 0 2.962 2.962 2.92 2.92 0 0 0-.134-.862l2.825-2.826a5.44 5.44 0 0 0 3.097.962 5.493 5.493 0 0 0 5.486-5.486 5.493 5.493 0 0 0-4.945-5.468z" fill="currentColor"/>
    </svg>
  );
}

const LOGO_MAP: Record<string, React.FC<LogoProps>> = {
  gmail: GmailLogo,
  googlecalendar: GoogleCalendarLogo,
  slack: SlackLogo,
  notion: NotionLogo,
  googledrive: GoogleDriveLogo,
  github: GitHubLogo,
  jira: JiraLogo,
  trello: TrelloLogo,
  todoist: TodoistLogo,
  linear: LinearLogo,
  asana: AsanaLogo,
  hubspot: HubSpotLogo,
};

export function AppBrandLogo({ appId, className, size = 24 }: { appId: string } & LogoProps) {
  const Logo = LOGO_MAP[appId];
  if (!Logo) return null;
  return <Logo className={className} size={size} />;
}

export function hasBrandLogo(appId: string): boolean {
  return appId in LOGO_MAP;
}
