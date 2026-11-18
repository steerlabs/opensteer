import { useEffect, useEffectEvent, useState } from "react";
import { useSearchParams } from "react-router";
import { RequestIdSchema, type Request } from "@opensteer/core";
import { requestReceipt, type HostClient } from "@opensteer/client/host";
import { classifyClientFailure, isMissingClientResource } from "@opensteer/client/connections";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { Unavailable } from "./unavailable.js";

type Shown = Request | { readonly state: "unavailable" | "unloaded"; readonly id: string };

/**
 * The Request a link named with `?requestId=`. The address is released at
 * once, so the target is held here: only a newer target, another task or
 * unmounting abandons its read. One still waiting goes to `onPending`, to be
 * answered where it is; one that has ended is shown.
 */
export function useLinkedRequest(
  hostClient: HostClient,
  threadId: string,
  onPending: (requestId: string) => void,
) {
  const [search, setSearch] = useSearchParams();
  const named = search.get("requestId");
  const [target, setTarget] = useState<{ readonly id: string; readonly threadId: string } | null>(
    null,
  );
  const [shown, setShown] = useState<Shown | null>(null);
  const pending = useEffectEvent(onPending);
  useEffect(() => {
    if (!named) return;
    setTarget({ id: named, threadId });
    setSearch(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("requestId");
        return next;
      },
      { replace: true },
    );
  }, [named, threadId]);
  useEffect(() => {
    setShown(null);
    if (!target || target.threadId !== threadId) return;
    const parsed = RequestIdSchema.safeParse(target.id);
    const unavailable = (id: string) => setShown({ state: "unavailable", id });
    if (!parsed.success) return unavailable(target.id);
    const requestId = parsed.data;
    let current = true;
    void hostClient.readRequest(threadId, requestId).then(
      (request) => {
        if (!current) return;
        if (!request) {
          hostClient.references.unavailable(requestId);
          return unavailable(requestId);
        }
        if (request.status === "pending") pending(request.id);
        else setShown(request);
      },
      (error: unknown) => {
        if (!current) return;
        if (notFound(error)) {
          hostClient.references.unavailable(requestId);
          return unavailable(requestId);
        }
        setShown({ state: "unloaded", id: requestId });
      },
    );
    return () => {
      current = false;
    };
  }, [hostClient, target, threadId]);
  return shown ? (
    <LinkedRequest
      onClose={() => setShown(null)}
      onRetry={(id) => setTarget({ id, threadId })}
      request={shown}
    />
  ) : null;
}

/** Whether the Host refused a read because the thing is gone or not this reader's. */
export function notFound(error: unknown): boolean {
  return isMissingClientResource(classifyClientFailure(error));
}

/**
 * A Request a link named, read-only: what it asked and how it ended. It is
 * never offered to be answered again; one still waiting opens in the dock instead.
 */
function LinkedRequest({
  onClose,
  onRetry,
  request,
}: {
  readonly onClose: () => void;
  readonly onRetry: (id: string) => void;
  readonly request: Shown;
}) {
  if ("state" in request)
    return (
      <Dialog onClose={onClose} title="Request">
        <Unavailable
          backLabel="Close"
          unloaded={request.state === "unloaded" ? "this request" : null}
          onBack={onClose}
          onRetry={() => onRetry(request.id)}
        />
      </Dialog>
    );
  if (request.status === "pending") return null;
  const receipt = requestReceipt(request);
  return (
    <Dialog onClose={onClose} title="Request">
      <div className="ref-request">
        <p className="ref-request__status">
          <Icon name={request.status === "fulfilled" ? "check-circle" : "stop"} />
          {receipt.outcome}
        </p>
        <p className="ref-request__title">{receipt.title}</p>
      </div>
    </Dialog>
  );
}
