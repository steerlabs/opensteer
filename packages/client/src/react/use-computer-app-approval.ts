import { useLayoutEffect, useRef, useState } from "react";
import type { HostClient } from "../host/index.js";
import {
  reviewComputerAppApproval,
  respondComputerAppApproval,
  type ComputerAppApprovalReview,
} from "../integrations/computer-app-approval.js";

/**
 * Answers on their way to the Host, by setup request. They outlive the surface
 * that sent them, because a person can close a sheet mid-answer and reopen it:
 * the answer isn't cancelled, and it blocks another until it settles.
 */
const answering = new Map<string, Promise<"allow" | "deny" | null>>();

/** Review details exist only in this mounted owner surface, never in the Host snapshot. */
export function useComputerAppApproval(hostClient: HostClient) {
  const [review, setReview] = useState<ComputerAppApprovalReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<((allowed: boolean) => void) | null>(null);
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  // The setup request on screen. An answer settles it even after a close and reopen.
  const shown = useRef<string | null>(null);
  function clear() {
    generation.current += 1;
    shown.current = null;
    abort.current?.abort();
    setReview(null);
    setBusy(false);
    setError(null);
    pending.current?.(false);
    pending.current = null;
  }
  useLayoutEffect(() => {
    clear();
    const owner = hostClient.getSnapshot().user?.id;
    const detach = hostClient.subscribe(() => {
      if (hostClient.getSnapshot().user?.id !== owner) clear();
    });
    return () => {
      detach();
      generation.current += 1;
      shown.current = null;
      abort.current?.abort();
      pending.current?.(false);
      pending.current = null;
    };
  }, [hostClient]);
  async function ask(setupRequestId: string): Promise<boolean> {
    clear();
    const current = generation.current;
    const signal = new AbortController();
    abort.current = signal;
    let value: ComputerAppApprovalReview;
    try {
      value = await reviewComputerAppApproval(hostClient, setupRequestId, signal.signal);
    } catch (error) {
      // Closed while loading: nothing was answered.
      if (current !== generation.current) return false;
      throw error;
    }
    if (current !== generation.current) return false;
    shown.current = value.request.id;
    setError(null);
    setReview(value);
    const inFlight = answering.get(value.request.id);
    setBusy(inFlight !== undefined);
    void inFlight?.then((decision) => {
      if (shown.current !== value.request.id) return;
      setBusy(false);
      if (decision !== null) settle(decision);
    });
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
    });
  }
  function settle(decision: "allow" | "deny") {
    shown.current = null;
    pending.current?.(decision === "allow");
    pending.current = null;
    setReview(null);
  }
  /** `secrets`: allowing a server, what was entered for the secrets it asks for. */
  async function answer(decision: "allow" | "deny", secrets?: Readonly<Record<string, string>>) {
    if (!review) return;
    const id = review.request.id;
    if (answering.has(id)) return;
    setBusy(true);
    setError(null);
    let reply: (decision: "allow" | "deny" | null) => void = () => undefined;
    answering.set(id, new Promise((resolve) => (reply = resolve)));
    try {
      await respondComputerAppApproval(hostClient, id, decision, secrets);
      answering.delete(id);
      reply(decision);
      if (shown.current !== id) return;
      settle(decision);
      await hostClient.refresh();
    } catch (reason) {
      answering.delete(id);
      reply(null);
      if (shown.current === id)
        setError(reason instanceof Error ? reason.message : "Couldn't record this answer.");
    } finally {
      setBusy(false);
    }
  }
  return { ask, review, error, busy, close: clear, answer };
}
