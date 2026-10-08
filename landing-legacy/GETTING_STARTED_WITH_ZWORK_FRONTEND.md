# Getting Started with zWork Frontend Code

## 📦 What You Have

You now have a complete copy of the zWork frontend codebase in `/zwork-frontend/` directory within zWorkLander. This includes:

- ✅ 89 TypeScript/React source files
- ✅ 30+ reusable UI components
- ✅ Complete styling configuration (Tailwind CSS, PostCSS)
- ✅ Theme and utilities
- ✅ Static assets

**Total Size:** 856 KB

## 🚀 Quick Start: Using Components in Landing Page

### 1. Import a Component

```typescript
// In your landing page demo component
import ChatView from '../zwork-frontend/src/components/ChatView';

export function DemoSection() {
  return (
    <section className="py-12">
      <h2 className="text-3xl font-bold mb-8">zWork in Action</h2>
      <div className="border rounded-lg overflow-hidden h-96">
        <ChatView />
      </div>
    </section>
  );
}
```

### 2. Use Multiple Components Together

```typescript
import ChatView from '../zwork-frontend/src/components/ChatView';
import ArtifactPanel from '../zwork-frontend/src/components/ArtifactPanel';
import PreviewShell from '../zwork-frontend/src/components/PreviewShell';

export function FullAppDemo() {
  return (
    <div className="grid grid-cols-3 gap-4 h-96 border rounded-lg overflow-hidden">
      <ChatView />
      <ArtifactPanel />
      <PreviewShell />
    </div>
  );
}
```

### 3. Style It

Use Tailwind classes to position and style the mockup:

```typescript
export function AppMockupShowcase() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12">
      <div className="rounded-lg overflow-hidden shadow-2xl border border-gray-200 bg-white">
        <div className="h-96 bg-gradient-to-b from-gray-50 to-white flex">
          {/* Component goes here */}
        </div>
      </div>
    </div>
  );
}
```

## 📚 Documentation Files

### Quick Reference
- **ZWORK_EXTRACTION_SUMMARY.md** - What was extracted and quick reference
- **This file** - Getting started guide

### Detailed Guides
- **zwork-frontend/README.md** - Structure overview and component list
- **ZWORK_INTEGRATION.md** - Comprehensive integration guide with examples

### Source Code Organization
```
zwork-frontend/
├── src/
│   ├── components/          ← UI components for mockups
│   ├── pages/              ← Page-level layouts
│   ├── lib/                ← Utilities and helpers
│   ├── hooks/              ← Custom React hooks
│   ├── App.tsx             ← Main app component
│   └── index.css           ← Global styles
├── public/                 ← Images and assets
├── package.json            ← Dependencies
└── tailwind.config.js      ← Theme config
```

## 🎯 Most Useful Components for Mockups

### For Showing AI Chat
```typescript
import ChatView from '../zwork-frontend/src/components/ChatView';
```
Shows conversation interface with AI responses.

### For Showing Code/Artifacts
```typescript
import ArtifactPanel from '../zwork-frontend/src/components/ArtifactPanel';
```
Displays code, documents, or other generated content.

### For Terminal Output
```typescript
import PreviewShell from '../zwork-frontend/src/components/PreviewShell';
```
Shows command-line interface and terminal output.

### For Individual Messages
```typescript
import Message from '../zwork-frontend/src/components/Message';
```
Render single messages with formatting.

### For Input
```typescript
import ChatInput from '../zwork-frontend/src/components/ChatInput';
```
User message input component.

### For Settings
```typescript
import Settings from '../zwork-frontend/src/components/Settings';
```
User preferences panel.

## 🎨 Styling Patterns

### Use Component Defaults
Components come with built-in styling via Tailwind. Just use them as-is:

```typescript
<div className="h-96 border rounded-lg overflow-hidden">
  <ChatView /> {/* Already styled internally */}
</div>
```

### Override with Wrapper Classes
Add your own classes for positioning and layout:

```typescript
<div className="flex h-96 gap-4 p-4 bg-gray-50 rounded-lg">
  <div className="flex-1 border rounded">
    <ChatView />
  </div>
  <div className="flex-1 border rounded">
    <ArtifactPanel />
  </div>
</div>
```

### Apply Landing Page Styles
Integrate with your existing landing page styling:

```typescript
<section className="py-12 bg-gradient-to-b from-white to-gray-50">
  <div className="container mx-auto">
    <h2 className="text-4xl font-bold mb-8">Watch zWork in Action</h2>
    <div className="rounded-xl shadow-2xl overflow-hidden border border-gray-200">
      <ChatView />
    </div>
  </div>
</section>
```

## 🔧 Common Tasks

### Mock Chat Data
If you want to pre-populate the chat with demo messages:

```typescript
const mockMessages = [
  {
    id: '1',
    role: 'user',
    content: 'Build a React todo app',
    timestamp: Date.now()
  },
  {
    id: '2',
    role: 'assistant',
    content: '```tsx\n// React component code here\n```',
    timestamp: Date.now() + 1000
  }
];

// Pass to component if it accepts props
<ChatView messages={mockMessages} />
```

### Show Only Code Viewer
To display just code artifacts:

```typescript
import ArtifactCodeViewer from '../zwork-frontend/src/components/artifacts/ArtifactCodeViewer';

<ArtifactCodeViewer
  code="const hello = 'world';"
  language="javascript"
/>
```

### Show Only Preview
For HTML/React preview mockups:

```typescript
import ArtifactPreviewViewer from '../zwork-frontend/src/components/artifacts/ArtifactPreviewViewer';

<ArtifactPreviewViewer html="<h1>Hello World</h1>" />
```

### Show Document
For markdown/document display:

```typescript
import ArtifactDocViewer from '../zwork-frontend/src/components/artifacts/ArtifactDocViewer';

<ArtifactDocViewer markdown="# Title\n\nContent here" />
```

## 📱 Responsive Design

Components are designed to be responsive, but make sure your wrapper is too:

```typescript
export function ResponsiveDemoSection() {
  return (
    <section className="py-8 md:py-12">
      <div className="mx-auto px-4 sm:px-6 lg:px-8 max-w-7xl">
        {/* Single column on mobile */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ChatView />
          <ArtifactPanel />
        </div>
      </div>
    </section>
  );
}
```

## 🌙 Dark Mode

Components support dark mode. Ensure your landing page dark mode is compatible:

```typescript
export function DarkModeDemoSection() {
  return (
    <div className="bg-white dark:bg-slate-900 p-4">
      <ChatView /> {/* Automatically adapts to dark mode */}
    </div>
  );
}
```

## ⚙️ Configuration

### Theme Colors
Reference the zWork theme from the extracted config:

```typescript
import theme from '../zwork-frontend/tailwind.config.js';
```

### Tailwind Integration
The zWork components use Tailwind CSS classes. Ensure your project's Tailwind config includes:
- All necessary color palettes
- Custom plugins used by zWork
- Dark mode support

### PostCSS
Make sure your project uses PostCSS with Tailwind. Config is included in zwork-frontend/.

## 📝 Examples in the Wild

### Landing Page Hero Section with App Demo
```typescript
import ChatView from '../zwork-frontend/src/components/ChatView';

export function HeroWithDemo() {
  return (
    <section className="py-20">
      <div className="grid grid-cols-2 gap-12 items-center">
        <div>
          <h1 className="text-5xl font-bold mb-4">Build with zWork</h1>
          <p className="text-xl text-gray-600 mb-8">
            AI-powered development platform for faster coding.
          </p>
        </div>
        <div className="rounded-lg overflow-hidden shadow-2xl border">
          <ChatView />
        </div>
      </div>
    </section>
  );
}
```

### Feature Showcase with Different Views
```typescript
import ChatView from '../zwork-frontend/src/components/ChatView';
import ArtifactPanel from '../zwork-frontend/src/components/ArtifactPanel';
import PreviewShell from '../zwork-frontend/src/components/PreviewShell';

export function FeatureShowcase() {
  return (
    <section className="py-12 space-y-8">
      <div className="text-center mb-12">
        <h2 className="text-4xl font-bold">Key Features</h2>
      </div>

      <div className="space-y-8">
        {/* AI Chat Feature */}
        <div className="grid grid-cols-2 gap-8 items-center">
          <div>
            <h3 className="text-2xl font-bold mb-4">AI-Powered Chat</h3>
            <p className="text-gray-600 mb-4">
              Natural language coding with GPT-4 and Claude 3.
            </p>
          </div>
          <div className="h-96 rounded-lg overflow-hidden border">
            <ChatView />
          </div>
        </div>

        {/* Code Generation Feature */}
        <div className="grid grid-cols-2 gap-8 items-center">
          <div className="h-96 rounded-lg overflow-hidden border order-2">
            <ArtifactPanel />
          </div>
          <div className="order-1">
            <h3 className="text-2xl font-bold mb-4">Generate Code</h3>
            <p className="text-gray-600 mb-4">
              Get production-ready code with syntax highlighting.
            </p>
          </div>
        </div>

        {/* Terminal Feature */}
        <div className="grid grid-cols-2 gap-8 items-center">
          <div>
            <h3 className="text-2xl font-bold mb-4">Terminal Integration</h3>
            <p className="text-gray-600 mb-4">
              Run commands and see output in real-time.
            </p>
          </div>
          <div className="h-96 rounded-lg overflow-hidden border bg-black">
            <PreviewShell />
          </div>
        </div>
      </div>
    </section>
  );
}
```

## 🐛 Troubleshooting

### Component Not Found
Make sure import path is correct:
```typescript
// ✅ Correct
import ChatView from '../zwork-frontend/src/components/ChatView';

// ❌ Wrong
import ChatView from './zwork-frontend/components/ChatView';
```

### Styling Not Applied
Ensure Tailwind CSS is imported in your global styles:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

### Components Look Wrong
Check for CSS conflicts. Use browser DevTools to inspect classes.

### Import Errors
Verify all files exist in `zwork-frontend/src/`. Use exact file names with .tsx extension.

## 📖 Next Steps

1. **Review the code** - Browse `zwork-frontend/src/components/` to understand structure
2. **Read documentation** - Check `ZWORK_INTEGRATION.md` for detailed examples
3. **Start small** - Import one component and test it
4. **Build demos** - Create your mockup sections incrementally
5. **Test responsive** - Ensure it works on mobile, tablet, desktop
6. **Check dark mode** - Verify styling in both light and dark modes

## 🔄 Keeping It Updated

To get the latest frontend code from zWork:

1. Go to `/Users/ll/zwork/app/`
2. Package the source: `tar -czf /tmp/zwork_frontend.tar.gz src/ ...`
3. Extract to zWorkLander: `tar -xzf /tmp/zwork_frontend.tar.gz -C zwork-frontend/`

See `zwork-frontend/README.md` for the full command.

## 💡 Tips & Tricks

- **Responsive Height**: Use `h-96` or `h-screen` for mockups
- **Scrolling**: Add `overflow-hidden` to prevent scroll bars
- **Shadows**: Use `shadow-lg` or `shadow-2xl` for depth
- **Borders**: Add `border border-gray-200 dark:border-slate-700` for definition
- **Rounded Corners**: Use `rounded-lg` or `rounded-xl` for polish

---

**Ready to build amazing mockups! 🚀**

Questions? Check:
1. ZWORK_INTEGRATION.md - Detailed examples
2. zwork-frontend/README.md - Component reference
3. zwork-frontend/src/ - Actual component code

Good luck! 🎉
