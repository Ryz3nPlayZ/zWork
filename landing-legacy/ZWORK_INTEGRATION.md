# zWork Frontend Integration Guide

This guide explains how to use the extracted zWork frontend code (`/zwork-frontend/`) to create mockups and demos in the zWorkLander landing page.

## Overview

The `/zwork-frontend/` directory contains the complete source code of the zWork application's frontend. This allows you to:

1. **Create accurate mockups** of the app without running the full zWork application
2. **Use real UI components** from the app in your landing page demos
3. **Reference styling and architecture** for maintaining consistency
4. **Build interactive examples** showing product features

## File Structure

```
zwork-frontend/
├── README.md                   # Overview and usage guide
├── src/                        # Complete frontend source code
│   ├── components/            # All reusable UI components
│   ├── pages/                # Page-level components
│   ├── lib/                  # Utilities, API client, state management
│   ├── hooks/                # Custom React hooks
│   ├── App.tsx               # Main application component
│   └── index.css             # Global styles
├── public/                    # Static assets (icons, images)
├── package.json              # Dependency specifications
├── tailwind.config.js        # Tailwind CSS theme
└── postcss.config.js         # PostCSS configuration
```

## Key Components for Mockups

### Chat Interface
**Path:** `zwork-frontend/src/components/ChatView.tsx`

The main chat interface component. Use this for showing:
- Conversation history
- AI assistant responses
- User messages
- Message formatting

**Example Usage:**
```typescript
import ChatView from '../zwork-frontend/src/components/ChatView';

export function ChatMockup() {
  return (
    <div className="h-full border border-gray-200 rounded-lg overflow-hidden">
      <ChatView />
    </div>
  );
}
```

### Artifact Panel
**Path:** `zwork-frontend/src/components/ArtifactPanel.tsx`

Displays different types of artifacts:
- Code files
- Documents
- Previews
- Graphs
- Spreadsheets

**Example Usage:**
```typescript
import ArtifactPanel from '../zwork-frontend/src/components/ArtifactPanel';

export function ArtifactMockup() {
  return (
    <div className="h-96 border border-gray-200 rounded-lg">
      <ArtifactPanel />
    </div>
  );
}
```

### Terminal/Shell Preview
**Path:** `zwork-frontend/src/components/PreviewShell.tsx`

Shows command-line interface or terminal output:
- Command execution
- Terminal output
- Build logs
- CLI interactions

**Example Usage:**
```typescript
import PreviewShell from '../zwork-frontend/src/components/PreviewShell';

export function TerminalMockup() {
  return (
    <div className="h-64 bg-black rounded-lg overflow-hidden">
      <PreviewShell />
    </div>
  );
}
```

### Message Component
**Path:** `zwork-frontend/src/components/Message.tsx`

Individual message rendering:
- User messages
- AI responses
- System messages
- Message formatting and syntax highlighting

**Example Usage:**
```typescript
import Message from '../zwork-frontend/src/components/Message';

export function MessageMockup() {
  const mockMessage = {
    id: '1',
    role: 'assistant',
    content: 'This is a sample response',
    timestamp: Date.now()
  };

  return <Message message={mockMessage} />;
}
```

### Sidebar Navigation
**Path:** `zwork-frontend/src/components/Sidebar.tsx`

Left navigation panel showing:
- Project list
- Navigation menu
- Quick actions
- Settings access

### Settings Panel
**Path:** `zwork-frontend/src/components/Settings.tsx`

User configuration interface:
- Model selection
- Theme preferences
- API settings
- User preferences

### Onboarding Flow
**Path:** `zwork-frontend/src/components/Onboarding.tsx`

First-time user experience:
- Welcome screens
- Feature introduction
- Quick start guide
- Initial setup steps

## Artifact Viewers

For displaying different content types:

### Code Viewer
**Path:** `zwork-frontend/src/components/artifacts/ArtifactCodeViewer.tsx`

Displays syntax-highlighted code with:
- Language detection
- Line numbers
- Copy button
- Code formatting

### Document Viewer
**Path:** `zwork-frontend/src/components/artifacts/ArtifactDocViewer.tsx`

Renders markdown documents:
- Heading formatting
- Lists and tables
- Code blocks
- Links and images

### Preview Viewer
**Path:** `zwork-frontend/src/components/artifacts/ArtifactPreviewViewer.tsx`

Live preview of HTML/React:
- Sandboxed preview
- Responsive testing
- Interactive elements

### Graph Viewer
**Path:** `zwork-frontend/src/components/artifacts/ArtifactGraphViewer.tsx`

Visualization and graph rendering:
- Diagrams
- Charts
- Flow diagrams
- Network graphs

### Sheet Viewer
**Path:** `zwork-frontend/src/components/artifacts/ArtifactSheetViewer.tsx`

Spreadsheet-like data display:
- Tables
- Data grids
- CSV display
- Editable cells

## Styling & Theme

### Using Tailwind CSS
The zWork frontend uses Tailwind CSS v4. To use the same styles:

1. **Theme Configuration:** Copy `zwork-frontend/tailwind.config.js` into your Tailwind config
2. **Global Styles:** Reference `zwork-frontend/src/index.css` for style imports
3. **Theme Utilities:** Use `zwork-frontend/src/lib/theme.ts` for theme-related helpers

### Color Palette
Access theme colors from:
```typescript
import theme from '../zwork-frontend/src/lib/theme';

// Use theme colors for consistency
const buttonColor = theme.colors.primary;
```

### Dark Mode Support
The zWork app includes dark mode. Use theme utilities:
```typescript
import { cn } from '../zwork-frontend/src/lib/cn';

export function MyComponent() {
  return (
    <div className={cn(
      'bg-white dark:bg-slate-900',
      'text-slate-900 dark:text-white'
    )}>
      Content
    </div>
  );
}
```

## Utilities & Helpers

### API Client
**Path:** `zwork-frontend/src/lib/api.ts`

Reference API endpoint patterns:
```typescript
import * as api from '../zwork-frontend/src/lib/api';

// See how API calls are structured
// Use as reference for your own backend integration
```

### State Management
**Path:** `zwork-frontend/src/lib/store.ts`

Learn the app's state structure:
- User state
- Chat history
- Settings
- Project data

### Constants
**Path:** `zwork-frontend/src/lib/constants.ts`

Reference app-wide constants:
- API endpoints
- Model names
- Feature flags
- UI constants

### Custom Hooks
**Path:** `zwork-frontend/src/hooks/`

Reusable hook patterns:
- useChat - Chat message management
- useDarkMode - Theme switching
- useLocalStorage - Browser storage
- And others

## Integration Workflow

### Step 1: Import Components
```typescript
// In your landing page component
import ChatView from '../zwork-frontend/src/components/ChatView';
import ArtifactPanel from '../zwork-frontend/src/components/ArtifactPanel';
```

### Step 2: Create Mockup Wrapper
```typescript
export function ZworkDemoSection() {
  return (
    <section className="py-12">
      <h2 className="text-3xl font-bold mb-8">zWork in Action</h2>
      
      <div className="grid grid-cols-2 gap-8">
        <ChatMockup />
        <ArtifactsMockup />
      </div>
    </section>
  );
}
```

### Step 3: Add Mock Data
If components require data, use mock data:
```typescript
const mockMessages = [
  {
    id: '1',
    role: 'user',
    content: 'Create a React component for a todo list',
    timestamp: Date.now()
  },
  {
    id: '2',
    role: 'assistant',
    content: '```tsx\n// Component code...\n```',
    timestamp: Date.now() + 1000
  }
];
```

### Step 4: Style & Responsive
Ensure mockups work with your landing page:
```typescript
<div className="mx-auto max-w-6xl px-4">
  <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
    <ChatMockup />
    <ArtifactMockup />
  </div>
</div>
```

## Important Considerations

### Performance
- Components are production-ready but may have backend dependencies
- Mock external data to avoid API calls during demo
- Use React.memo for expensive components if needed

### Dependencies
- Components expect certain npm packages to be installed
- Ensure compatibility with your project's dependency versions
- See `zwork-frontend/package.json` for full dependency list

### Styling Conflicts
- Be careful of class name conflicts between zWork and zWorkLander
- Use CSS modules or scoped classes if needed
- Test in both light and dark modes

### Dark Mode
- zWork components support dark mode via Tailwind
- Ensure your landing page dark mode config is compatible
- Test component rendering in both modes

## Updating Frontend Code

To pull the latest frontend code from the zWork repository:

```bash
# From /Users/ll/zwork/app
tar -czf /tmp/zwork_frontend.tar.gz src/ package.json tailwind.config.js postcss.config.js index.html oauth-callback.html public/

# From /Users/ll/zWorkLander
tar -xzf /tmp/zwork_frontend.tar.gz -C zwork-frontend/ --strip-components=0
```

Or use the script in zwork-frontend/README.md for detailed instructions.

## Troubleshooting

### Component Not Rendering
1. Check that all dependencies are installed in your main package.json
2. Verify import paths are correct
3. Check browser console for error messages
4. Ensure required props are provided to components

### Styling Issues
1. Verify Tailwind CSS is properly configured
2. Check for CSS conflicts with existing styles
3. Ensure PostCSS config includes Tailwind
4. Clear build cache and rebuild

### API Call Errors
1. Mock API responses in development
2. Use the API utilities but don't call real endpoints
3. Provide dummy data for components
4. Check console for CORS or network errors

## Examples

### Complete Demo Section
```typescript
import ChatView from '../zwork-frontend/src/components/ChatView';
import ArtifactPanel from '../zwork-frontend/src/components/ArtifactPanel';
import PreviewShell from '../zwork-frontend/src/components/PreviewShell';

export function FullAppMockup() {
  return (
    <div className="h-screen grid grid-cols-3 gap-4 p-4 bg-gray-50 dark:bg-slate-900">
      {/* Sidebar */}
      <div className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
        <div className="p-4 border-b">
          <h3 className="font-semibold">Navigation</h3>
        </div>
      </div>

      {/* Chat */}
      <div className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden col-span-1">
        <ChatView />
      </div>

      {/* Artifacts */}
      <div className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
        <ArtifactPanel />
      </div>
    </div>
  );
}
```

---

**Last Updated:** May 2026  
**Source Repository:** https://github.com/Ryz3nPlayZ/zwork  
**Use Case:** Landing page mockups and product demos
