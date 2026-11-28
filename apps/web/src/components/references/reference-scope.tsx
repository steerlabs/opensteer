import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";
import { ThreadIdSchema, type ThreadId } from "@opensteer/core";
import { automationPath, type HostClient } from "@opensteer/client/host";
import type {
  FileOpenInput,
  PersonalReferenceNavigationPorts,
  ReferenceDestination,
  ReferenceRenderContext,
} from "@opensteer/client/references";
import { desktopBridge } from "../../desktop/desktop-bridge.js";
import { useAreaNavigate } from "../workspace/area-link.js";
import { useOptionalWorkspace } from "../workspace/workspace-context.js";
import { FileViewer } from "./file-viewer.js";

/** Whose words a chip sits in, and how it opens what it names: the Home's tasks, Runs and files. */
export interface ReferenceScope {
  readonly context: ReferenceRenderContext;
  readonly navigation: PersonalReferenceNavigationPorts;
}

const ReferenceScopeContext = createContext<ReferenceScope | null>(null);

export function useReferenceScope(): ReferenceScope | null {
  return useContext(ReferenceScopeContext);
}

export function ReferenceNavigationProvider({
  children,
  value,
}: {
  readonly children: ReactNode;
  readonly value: ReferenceScope;
}) {
  return <ReferenceScopeContext value={value}>{children}</ReferenceScopeContext>;
}

export function openOutside(url: string): void {
  const bridge = desktopBridge();
  if (bridge) void bridge.openExternalUrl({ url }).catch(globalThis.reportError);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Where a personal reference leads. A message, Run or Request opens its task
 * at that point; the task finds it there, or says it isn't available.
 */
export function useOpenPersonalDestination(
  openFile: (input: FileOpenInput) => Promise<void>,
): (destination: ReferenceDestination) => Promise<void> {
  const nav = useOptionalWorkspace()?.nav ?? null;
  const navigate = useNavigate();
  const openPage = useAreaNavigate();
  return useCallback(
    async (destination) => {
      const conversation = (
        threadId: string,
        options: { readonly messageId?: string; readonly query?: Record<string, string> } = {},
      ) => {
        const path = `/tasks/${encodeURIComponent(threadId)}`;
        const query = new URLSearchParams(options.query);
        if (nav) {
          nav.openConversation(
            query.size ? `${path}?${query}` : path,
            options.messageId ? { messageId: options.messageId } : {},
          );
          return;
        }
        if (options.messageId) query.set("messageId", options.messageId);
        void navigate(query.size ? `${path}?${query}` : path);
      };
      switch (destination.kind) {
        case "task":
          return conversation(destination.threadId);
        case "message":
          return conversation(destination.threadId, { messageId: destination.messageId });
        case "run":
          return conversation(destination.threadId, {
            messageId: destination.anchorMessageId,
            query: { runId: destination.runId },
          });
        case "request":
          return conversation(destination.threadId, {
            query: { requestId: destination.requestId },
          });
        case "automation":
          return openPage(automationPath(destination.triggerId));
        case "computer":
          return void navigate(`/settings/devices/${encodeURIComponent(destination.runnerId)}`);
        case "attachment":
          return openFile({
            source: { kind: "attachment", attachmentId: destination.attachmentId },
          });
        case "tab":
          if (nav) return nav.showPlace({ kind: "tab", tabId: destination.tabId });
          return void navigate(`/?panel=browser&tab=${encodeURIComponent(destination.tabId)}`);
      }
    },
    [nav, navigate, openFile, openPage],
  );
}

/**
 * Personal reference context for everything under it: one Deployment's
 * client, the task its words belong to, and the file viewer they open.
 */
export function PersonalReferences({
  children,
  client,
  threadId,
}: {
  readonly children: ReactNode;
  readonly client: HostClient;
  readonly threadId: string | null;
}) {
  const deploymentId = useSyncExternalStore(
    client.subscribe,
    () => client.getSnapshot().deploymentId ?? "",
    () => client.getSnapshot().deploymentId ?? "",
  );
  const parsedThreadId = threadId === null ? null : ThreadIdSchema.safeParse(threadId);
  const ownThreadId = parsedThreadId?.success ? parsedThreadId.data : null;
  const [file, setFile] = useState<{
    readonly input: FileOpenInput;
    readonly threadId: ThreadId | null;
  } | null>(null);
  // A file named in these words is read as this task's; an attachment reference may be another's.
  const openFile = useCallback(
    async (input: FileOpenInput) => setFile({ input, threadId: ownThreadId }),
    [ownThreadId],
  );
  const openAttachment = useCallback(
    async (input: FileOpenInput) => setFile({ input, threadId: null }),
    [],
  );
  const openReference = useOpenPersonalDestination(openAttachment);
  const value = useMemo<ReferenceScope>(
    () => ({
      context: { kind: "personal", client, deploymentId, threadId: ownThreadId },
      navigation: { openFile, openReference },
    }),
    [client, deploymentId, ownThreadId, openFile, openReference],
  );
  return (
    <ReferenceScopeContext value={value}>
      {children}
      {file ? (
        <FileViewer
          client={client}
          input={file.input}
          onClose={() => setFile(null)}
          threadId={file.threadId}
        />
      ) : null}
    </ReferenceScopeContext>
  );
}
