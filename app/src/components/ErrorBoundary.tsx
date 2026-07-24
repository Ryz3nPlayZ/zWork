import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("zWork render error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 text-center">
          <h2 className="mb-2 text-[18px] font-semibold text-ink">Something went wrong</h2>
          <p className="mb-4 text-[14px] text-ink-muted">
            {this.state.error?.message}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="press ring-focus rounded-lg bg-ink px-4 py-2 text-[13px] font-medium text-paper hover:bg-ink/90"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
