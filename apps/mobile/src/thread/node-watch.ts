import type {
  HostClient,
  NodeDetailSnapshot,
  NodeDetailSubscription,
} from "@opensteer/client/host";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const noSubscription = () => () => undefined;
const nothing = () => null;

/**
 * A subagent's own steps, watched from the Host only while `active`: a phone
 * looking at the parent conversation is never sent them. Released (blurred,
 * backgrounded, closed), the last steps drawn stay on screen rather than
 * emptying, and a new watch keeps them there until its own steps arrive.
 */
export function useNodeWatch(
  hostClient: HostClient,
  threadId: string,
  nodeId: string,
  active: boolean,
): {
  readonly snapshot: NodeDetailSnapshot | null;
  readonly watch: NodeDetailSubscription | null;
  /** The Host client could not watch it at all: its conversation is not one this reader holds. */
  readonly unreachable: boolean;
} {
  const [watch, setWatch] = useState<NodeDetailSubscription | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    if (!active) return;
    let opened: NodeDetailSubscription;
    try {
      opened = hostClient.watchNode(threadId, nodeId);
    } catch {
      setUnreachable(true);
      return;
    }
    setUnreachable(false);
    setWatch(opened);
    return () => {
      opened.release();
      setWatch((current) => (current === opened ? null : current));
    };
  }, [active, hostClient, nodeId, threadId]);
  const current = useSyncExternalStore(
    watch?.subscribe ?? noSubscription,
    watch?.getSnapshot ?? nothing,
  );
  const held = useRef<NodeDetailSnapshot | null>(null);
  if (
    current !== null &&
    current.status !== "closed" &&
    !(current.status === "loading" && held.current?.status === "ready")
  )
    held.current = current;
  return { snapshot: held.current, unreachable, watch };
}
