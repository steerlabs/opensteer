import { useCallback } from "react";
import type { TeamChannelId } from "@opensteer/core";
import type { TeamSessionClient } from "../team/team-session-client.js";
import { usePagedList } from "./use-paged-list.js";

export function useTeamShareParticipants(
  session: TeamSessionClient | null,
  channelId: TeamChannelId,
  query: string | null,
) {
  const read = useCallback(
    async (after: string | null) => {
      const page = await session!.shareParticipants({
        channelId,
        ...(after ? { after } : {}),
        ...(query?.trim() ? { query: query.trim().slice(0, 80) } : {}),
      });
      return { items: page?.participants ?? [], nextCursor: page?.nextCursor ?? null };
    },
    [session, channelId, query],
  );
  return usePagedList(
    session && query !== null ? read : null,
    `share-participants:${channelId}:${query}`,
  );
}
