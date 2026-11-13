import { useEffect, useSyncExternalStore } from "react";
import { TeamChannelIdSchema } from "@opensteer/core";
import { teamRpcResult } from "../team/rpc-result.js";
import type { TeamSessionClient, TeamSessionSnapshot } from "../team/team-session-client.js";
import { usePagedList } from "./use-paged-list.js";

export function useTeam(client: TeamSessionClient): TeamSessionSnapshot {
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}

/**
 * Every channel the reader may browse, read page after page until the team has no more (or
 * the list's bound), so it can be sorted and searched by name. The team pages it by id.
 */
export function useChannelDirectory(session: TeamSessionClient | null, key: string) {
  const list = usePagedList(
    session
      ? (cursor) =>
          session.rpc["team.channels.list"](
            cursor === null ? {} : { after: TeamChannelIdSchema.parse(cursor) },
          )
            .then(teamRpcResult)
            .then((page) => ({
              items: page.channels,
              nextCursor: page.hasMore ? (page.channels.at(-1)?.id ?? null) : null,
            }))
      : null,
    key,
  );
  const { error, loadingMore, more, nextCursor } = list;
  // `more` is new every render; the cursor names the page it reads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (nextCursor !== null && !loadingMore && error === null) more();
  }, [nextCursor, loadingMore, error]);
  return list;
}
