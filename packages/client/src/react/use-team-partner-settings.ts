import { useEffect, useMemo, useSyncExternalStore } from "react";
import { teamPartnerSettings } from "../team/partner-settings.js";
import type { TeamSessionClient } from "../team/team-session-client.js";

export function useTeamPartnerSettings(session: TeamSessionClient, focused = true) {
  const model = useMemo(() => teamPartnerSettings(session), [session]);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const links = useSyncExternalStore(
    model.links.subscribe,
    model.links.getState,
    model.links.getState,
  );
  const invites = useSyncExternalStore(
    model.invites.subscribe,
    model.invites.getState,
    model.invites.getState,
  );
  useEffect(() => {
    if (focused) void model.refresh();
  }, [model, focused]);
  return { model, state, links, invites };
}
