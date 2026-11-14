import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { TeamChannelId } from "@opensteer/core";
import { teamChannelShares } from "../team/channel-shares.js";
import type { TeamSessionClient } from "../team/team-session-client.js";

export function useTeamChannelShares(
  session: TeamSessionClient,
  channelId?: TeamChannelId,
  focused = true,
) {
  const model = useMemo(() => teamChannelShares(session, channelId), [session, channelId]);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => {
    if (focused) void model.refresh();
  }, [model, focused]);
  return { model, state };
}
