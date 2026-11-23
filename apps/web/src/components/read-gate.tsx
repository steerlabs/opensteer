import { createContext, useContext, type ReactNode } from "react";
import { agentWords } from "@opensteer/client/host";
import { Icon } from "./icon.js";

const ReadFailed = createContext(false);

/**
 * A page drawn from a read whose last attempt failed changes nothing until it is read again:
 * while `failed`, the one enabled control is this gate's Try again (which reads everything the
 * page shows again), the page's body is a disabled fieldset, and a dialog opened inside it closes
 * without acting (`useReadFailed`, which `Dialog` obeys). Links still go where they go. Used by
 * every page that shows what a Home last said and lets a person act on it: Messaging and a
 * connected agent's page.
 */
export function ReadGate({
  children,
  failed,
  message,
  onRetry,
}: {
  readonly children: ReactNode;
  readonly failed: boolean;
  /** What failed, in the page's words. */
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <ReadFailed.Provider value={failed}>
      {failed ? (
        <p className="notice notice--error" role="alert">
          <Icon name="alert-circle" />
          <span>{message}</span>{" "}
          <button className="btn btn--small" onClick={onRetry} type="button">
            {agentWords("common.tryAgain")}
          </button>
        </p>
      ) : null}
      <fieldset className="read-gate" disabled={failed}>
        {children}
      </fieldset>
    </ReadFailed.Provider>
  );
}

/** Whether the page this is drawn in last failed to read: nothing inside it may act. */
export function useReadFailed(): boolean {
  return useContext(ReadFailed);
}
