import { useLayoutEffect, useRef, useState } from "react";
import type { HostClient } from "../host/index.js";
import {
  reviewComputerAppApproval,
  respondComputerAppApproval,
  type ComputerAppApprovalReview,
} from "../integrations/computer-app-approval.js";

/** Review details exist only in this mounted owner surface, never in the Host snapshot. */
export function useComputerAppApproval(hostClient: HostClient) {
  const [review, setReview] = useState<ComputerAppApprovalReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<((allowed: boolean) => void) | null>(null);
  const generation = useRef(0);
  const submitting = useRef(false);
  const abort = useRef<AbortController | null>(null);
  // The setup request on screen. An answer settles it even after a close and reopen.
  const shown = useRef<string | null>(null);
  /** Also closes mid-answer: that answer is not cancelled, and blocks another until it settles. */
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
    setBusy(submitting.current);
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
    });
  }
  /** `secrets`: allowing a server, what was entered for the secrets it asks for. */
  async function answer(decision: "allow" | "deny", secrets?: Readonly<Record<string, string>>) {
    if (!review || submitting.current) return;
    const id = review.request.id;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await respondComputerAppApproval(hostClient, id, decision, secrets);
      if (shown.current !== id) return;
      shown.current = null;
      pending.current?.(decision === "allow");
      pending.current = null;
      setReview(null);
      await hostClient.refresh();
    } catch (reason) {
      if (shown.current === id)
        setError(reason instanceof Error ? reason.message : "Couldn't record this answer.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return { ask, review, error, busy, close: clear, answer };
}
