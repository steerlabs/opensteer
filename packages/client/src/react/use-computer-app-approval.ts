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
  function clear() {
    generation.current += 1;
    abort.current?.abort();
    setReview(null);
    setBusy(false);
    setError(null);
    pending.current?.(false);
    pending.current = null;
  }
  function close() {
    if (!submitting.current) clear();
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
      abort.current?.abort();
      pending.current?.(false);
      pending.current = null;
    };
  }, [hostClient]);
  async function ask(setupRequestId: string): Promise<boolean> {
    if (submitting.current) return false;
    clear();
    const current = generation.current;
    const signal = new AbortController();
    abort.current = signal;
    const value = await reviewComputerAppApproval(hostClient, setupRequestId, signal.signal);
    if (current !== generation.current) return false;
    setError(null);
    setReview(value);
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
    });
  }
  async function answer(decision: "allow" | "deny") {
    if (!review || submitting.current) return;
    const current = generation.current;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await respondComputerAppApproval(hostClient, review.request.id, decision);
      if (current !== generation.current) return;
      pending.current?.(decision === "allow");
      pending.current = null;
      setReview(null);
      await hostClient.refresh();
    } catch (reason) {
      if (current === generation.current)
        setError(reason instanceof Error ? reason.message : "Couldn't record this answer.");
    } finally {
      submitting.current = false;
      if (current === generation.current) setBusy(false);
    }
  }
  return { ask, review, error, busy, close, answer };
}
