export type BrowserActionRunner = (action: () => Promise<void>) => Promise<boolean>;

export async function runBrowserAction(
  action: () => Promise<void>,
  showError: (message: string) => void,
): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    showError(error instanceof Error ? error.message : "Opensteer couldn’t complete that action.");
    return false;
  }
}

export function BrowserActionAlert({ message }: { message: string | null }) {
  return message ? (
    <div className="browser-action-error" role="alert">
      {message}
    </div>
  ) : null;
}
