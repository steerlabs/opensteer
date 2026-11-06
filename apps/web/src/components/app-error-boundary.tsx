import { Component, type ErrorInfo, type ReactNode } from "react";
import { desktopBridge } from "../desktop/desktop-bridge.js";
import { StartupFailure } from "./onboarding-card.js";

/** Stack lines only: the error's own words can carry what must not reach a log. */
function codeFrames(stack: string | null | undefined): string[] {
  return (stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, 32)
    .map((line) => line.slice(0, 512));
}

function reportFailure(error: unknown, componentStack: string | null | undefined) {
  const name = error instanceof Error ? error.name : "";
  try {
    void desktopBridge()
      ?.reportRendererFailure?.({
        componentFrames: codeFrames(componentStack),
        errorFrames: codeFrames(error instanceof Error ? error.stack : null),
        errorName: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : "Error",
      })
      .catch(() => undefined);
  } catch {
    /* Logging cannot stand between the person and the way back. */
  }
}

/** A render failure unmounts the whole page, so this leaves a way back instead of nothing. */
export class AppErrorBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    reportFailure(error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <StartupFailure
        description="Reload to pick up where you left off."
        onRetry={() => window.location.reload()}
        retryLabel="Reload"
        title="Something went wrong"
      />
    );
  }
}
