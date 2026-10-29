import { useCallback, useEffect, useState } from "react";
import { reviewHostAction, type ActionReview, type ReviewedAction } from "../host/action-review.js";
import type { HostClient } from "../host/client.js";

/** Both native sheets and web dialogs dismiss as soon as their reviewed state ends. */
export function useActionReview(client: HostClient) {
  const [held, setHeld] = useState<{
    readonly client: HostClient;
    readonly review: ActionReview;
  } | null>(null);
  const dismiss = useCallback(() => {
    setHeld((value) => {
      value?.review.cancel();
      return null;
    });
  }, []);
  const ask = useCallback(
    (action: ReviewedAction, perform?: () => Promise<unknown>) => {
      const next = reviewHostAction(client, action, perform);
      setHeld((previous) => {
        previous?.review.cancel();
        return next ? { client, review: next } : null;
      });
    },
    [client],
  );
  useEffect(() => {
    if (!held) return;
    const invalidate = () => {
      if (held.client !== client || !held.review.current())
        setHeld((value) => (value === held ? null : value));
    };
    const unsubscribe = held.review.subscribe(invalidate);
    invalidate();
    return () => {
      unsubscribe();
      held.review.cancel();
    };
  }, [client, held]);
  return {
    review: held?.client === client && held.review.current() ? held.review : null,
    ask,
    dismiss,
  };
}
