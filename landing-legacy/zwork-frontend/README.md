# zWork Frontend Codebase

This directory contains the extracted frontend code from the zWork application. It's been extracted and organized to be used as a reference for creating mockups and demos in the zWorkLander landing page.

## Structure

```
zwork-frontend/
├── src/                          # Source code
│   ├── components/               # Reusable UI components
│   │   ├── artifacts/           # Artifact viewers (code, docs, graphs, etc)
│   │   ├── admin/               # Admin dashboard components
│   │   ├── icons/               # Icon components
│   │   ├── demos/               # Demo components
│   │   ├── ChatView.tsx         # Main chat interface
│   │   ├── ChatInput.tsx        # Message input component
│   │   ├── Sidebar.tsx          # Navigation sidebar
│   │   ├── ArtifactPanel.tsx    # Artifact display panel
│   │   ├── Message.tsx          # Message component
│   │   ├── PreviewShell.tsx     # Shell/terminal preview
│   │   ├── Onboarding.tsx       # Onboarding flow
│   │   ├── Settings.tsx         # Settings panel
│   │   └── [other components]
│   ├── pages/                   # Page-level components
│   │   ├── admin/              # Admin pages
│   │   └── [other pages]
│   ├── lib/                     # Utilities and helpers
│   │   ├── api.ts              # API client
│   │   ├── store.ts            # State management
│   │   ├── theme.ts            # Theme configuration
│   │   ├── constants.ts        # App constants
│   │   └── [other utilities]
│   ├── hooks/                  # Custom React hooks
│   ├── utils/                  # Utility functions
│   ├── demos/                  # Demo scenarios and content
│   ├── App.tsx                 # Main app component
│   ├── main.tsx                # Entry point
│   ├── index.css               # Global styles
│   └── vite-env.d.ts           # Vite type definitions
├── public/                      # Static assets
├── package.json                 # Dependencies
├── tailwind.config.js          # Tailwind CSS configuration
├── postcss.config.js           # PostCSS configuration
├── index.html                  # HTML template
└── oauth-callback.html         # OAuth callback page
```

## Key Components for Mockups

### Main Application Components
- **ChatView.tsx** - Main chat interface with message history
- **ChatInput.tsx** - Message input with formatting and commands
- **Sidebar.tsx** - Navigation and project list
- **ArtifactPanel.tsx** - Displays code, documents, previews, etc.
- **Message.tsx** - Individual message rendering

### Preview & Demo Components
- **PreviewShell.tsx** - Terminal/shell-like interface
- **Onboarding.tsx** - First-time user experience
- **Settings.tsx** - User preferences and configuration

### Artifact Viewers
- **ArtifactCodeViewer.tsx** - Syntax-highlighted code display
- **ArtifactDocViewer.tsx** - Document/markdown viewer
- **ArtifactPreviewViewer.tsx** - Live preview for HTML/apps
- **ArtifactGraphViewer.tsx** - Graph/visualization rendering
- **ArtifactSheetViewer.tsx** - Spreadsheet-like data

## How to Use in zWorkLander

### 1. Import Components for Mockups
```typescript
import ChatView from './zwork-frontend/src/components/ChatView';
import ArtifactPanel from './zwork-frontend/src/components/ArtifactPanel';
import PreviewShell from './zwork-frontend/src/components/PreviewShell';

export function AppMockupDemo() {
  return (
    <div className="flex h-full">
      <ChatView />
      <ArtifactPanel />
    </div>
  );
}
```

### 2. Use Styles & Theme
- Tailwind CSS configuration is in `tailwind.config.js`
- Global styles in `src/index.css`
- Theme configuration in `src/lib/theme.ts`

### 3. Reference API & Store
- `src/lib/api.ts` - API endpoint definitions
- `src/lib/store.ts` - State management patterns
- `src/lib/constants.ts` - App-wide constants

## Important Notes

- This is a **read-only reference** for mockup creation
- Do not modify these files directly in the zWorkLander codebase
- If you need to update the frontend code, pull changes from the main zWork repository
- Use these components as templates for creating landing page demos

## Dependencies

Key packages used:
- React 19
- TypeScript 5.7
- Tailwind CSS 4.0
- Vite 6.2
- PostCSS 8
- And many others (see package.json)

## Updating This Extraction

To pull the latest frontend code from zWork:

```bash
cd /Users/ll/zwork/app
tar -czf /tmp/zwork_frontend.tar.gz src/ package.json tailwind.config.js postcss.config.js index.html oauth-callback.html public/

cd /Users/ll/zWorkLander
rm -rf zwork-frontend/src zwork-frontend/package.json zwork-frontend/tailwind.config.js zwork-frontend/postcss.config.js
tar -xzf /tmp/zwork_frontend.tar.gz -C zwork-frontend/
```

---

**Last Updated:** May 2026  
**Source:** https://github.com/Ryz3nPlayZ/zwork  
**Purpose:** Reference for mockups and demos in zWorkLander landing page
