import { useCallback, useEffect } from "react";
import type { HostClient } from "../host/client.js";
import {
  runPageConsidered,
  runPageFolded,
  runPageOpened,
  runPagePaged,
  runPageShown,
  runPageSize,
  type RunPageMoment,
} from "../host/run-page.js";
import { runPageDesktopAspect, runPageKeptTranscript } from "../host/run-page-memory.js";
import { useRunPageView } from "./use-run-page-view.js";
import { useRunPlace } from "./use-places.js";
import { useRunPlacePicture } from "./use-run-place-picture.js";

export interface RunPageInput extends Omit<RunPageMoment, "picture"> {
  readonly hostClient: HostClient;
  readonly threadId: string;
  readonly runId: string | null;
  /** Pane focus and coverage, independent of app background suspension. */
  readonly paneVisible: boolean;
  readonly room: { readonly height: number; readonly width: number } | null;
  readonly transcript?: number;
  readonly headHasRoom: boolean;
}

export function useRunPage(input: RunPageInput) {
  const { hostClient, threadId, runId, visible } = input;
  const entry = useRunPlace(hostClient, runId);
  const picture = useRunPlacePicture(hostClient, threadId, runId, input.paneVisible);
  const [view, update] = useRunPageView(hostClient, threadId);
  const moment: RunPageMoment = {
    visible,
    picture: picture.usable,
    typing: input.typing,
    scrolledUp: input.scrolledUp,
    cellular: input.cellular,
  };
  const memory = runPageConsidered(view.memory, runId, moment);
  const page =
    input.room === null
      ? null
      : runPageSize({
          aspect: picture.aspect ?? runPageDesktopAspect,
          room: input.room.height,
          width: input.room.width,
          transcript: input.transcript ?? runPageKeptTranscript,
        });
  const placeRunId = entry?.runId ?? null;
  const fits = page !== null;
  const shown = runPageShown(memory, placeRunId, fits, {
    picture: picture.usable,
    headHasRoom: input.headHasRoom,
  });
  useEffect(() => {
    update((current) => {
      let next = runPageConsidered(current.memory, runId, {
        visible,
        picture: picture.usable,
        typing: input.typing,
        scrolledUp: input.scrolledUp,
        cellular: input.cellular,
      });
      const currentShown = runPageShown(next, placeRunId, fits, {
        picture: picture.usable,
        headHasRoom: input.headHasRoom,
      });
      if (visible && currentShown === "page" && placeRunId !== null)
        next = runPagePaged(next, placeRunId);
      return {
        ...current,
        memory: next,
        runId: placeRunId,
        shown: currentShown,
        room: fits,
        picture,
      };
    });
  }, [
    input.cellular,
    input.headHasRoom,
    input.scrolledUp,
    input.typing,
    fits,
    picture,
    placeRunId,
    runId,
    update,
    visible,
    view.memory,
  ]);
  useEffect(
    () => () => {
      update((current) => ({ ...current, runId: null, shown: "none" }));
    },
    [update],
  );
  const fold = useCallback(
    () => update((current) => ({ ...current, memory: runPageFolded(current.memory) })),
    [update],
  );
  const open = useCallback(() => {
    if (runId !== null)
      update((current) => ({ ...current, memory: runPageOpened(runId, current.memory) }));
  }, [runId, update]);
  return { entry, shown, page, picture, fold, open };
}
