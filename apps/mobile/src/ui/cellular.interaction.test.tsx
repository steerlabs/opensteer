// @vitest-environment happy-dom

import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  freshRunPageMemory,
  runPageConsidered,
  runPageShown,
  type RunPageMemory,
} from "@opensteer/client/host";
import { useCellular } from "./cellular.js";

const network = vi.hoisted(() => ({ type: undefined as string | undefined }));
vi.mock("expo-network", () => ({
  NetworkStateType: { UNKNOWN: "UNKNOWN", CELLULAR: "CELLULAR" },
  useNetworkState: () => network,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it.each(["WIFI", "CELLULAR"])("waits for %s with a Run place already present", async (type) => {
  network.type = undefined;
  let observed: RunPageMemory = freshRunPageMemory;
  function Page() {
    const cellular = useCellular();
    const [memory, update] = useState(freshRunPageMemory);
    observed = memory;
    useEffect(() => {
      update((value) =>
        runPageConsidered(value, "run-present", {
          cellular,
          scrolledUp: false,
          typing: false,
          visible: true,
          picture: true,
        }),
      );
    }, [cellular]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Page />));
    expect(observed.run?.intent).toBe("undecided");
    network.type = "UNKNOWN";
    await act(async () => root.render(<Page />));
    expect(observed.run?.intent).toBe("undecided");
    network.type = type;
    await act(async () => root.render(<Page />));
    expect(observed.run?.runId).toBe("run-present");
    expect(runPageShown(observed, "run-present", true)).toBe(
      type === "CELLULAR" ? "folded" : "page",
    );
  } finally {
    await act(async () => root.unmount());
  }
});
