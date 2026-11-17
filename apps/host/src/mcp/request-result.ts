import { formatReferenceLink, type Request } from "@opensteer/core";

export function immediateRequestResult(
  kind: Request["kind"],
  status: "fulfilled" | "blocked",
  next: string,
) {
  return { requestId: null, kind, status, next };
}

export function requestResult(
  request: Pick<Request, "id" | "kind" | "status">,
  next: string,
  replayed?: boolean,
) {
  return {
    requestId: request.id,
    link: formatReferenceLink(request.id, "Request"),
    kind: request.kind,
    status: request.status,
    ...(replayed === undefined ? {} : { replayed }),
    next,
  };
}
