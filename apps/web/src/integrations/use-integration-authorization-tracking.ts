import { useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import type { IntegrationAuthorizationStart } from "@opensteer/integration-core";

type AttemptId = IntegrationAuthorizationStart["attemptId"];
export interface IntegrationAuthorizationTracking {
  readonly started: (attemptId: AttemptId) => void;
  readonly finished: (attemptId: AttemptId) => void;
}

/** Router-owned recovery state contains an id only, never the launch capability. */
export function useIntegrationAuthorizationTracking(): IntegrationAuthorizationTracking {
  const location = useLocation();
  const navigate = useNavigate();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A waiter retains its callbacks across renders; completion must read the latest route.
  const current = useRef(location);
  current.current = location;
  return useMemo(() => {
    const update = (attemptId: AttemptId, finished: boolean) => {
      if (!mounted.current) return;
      const route = current.current;
      const query = new URLSearchParams(route.search);
      if (finished) {
        if (query.get("integrationAttempt") !== attemptId) return;
        query.delete("integrationAttempt");
      } else query.set("integrationAttempt", attemptId);
      const next = { ...route, search: query.size ? `?${query}` : "" };
      current.current = next;
      void navigate(
        { pathname: next.pathname, search: next.search, hash: next.hash },
        {
          replace: true,
          state: next.state,
        },
      );
    };
    return {
      started: (attemptId: AttemptId) => update(attemptId, false),
      finished: (attemptId: AttemptId) => update(attemptId, true),
    };
  }, [navigate]);
}
