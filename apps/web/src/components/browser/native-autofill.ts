import {
  autofillKey,
  type BrowserEditingState,
  type BrowserEditingTarget,
} from "@opensteer/client/host";
import type { DesktopAutofillScene } from "@opensteer/protocol/desktop";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { desktopBridge } from "../../desktop/desktop-bridge.js";
import { useMediaQuery } from "../../ui-utils.js";
import { useNativeBrowserLayer } from "../native-browser-overlays.js";
import { useAutofillResultNotice } from "./autofill-chooser.js";
import type { NativeBrowserPlacement } from "./native-browser-presentation.js";

/**
 * The chooser over a page this window shows natively. The offer and its state
 * stay here; main only places the popup, draws it from the scene and reports
 * the person's choice. True while it is shown, when its four keys are its own.
 */
export function useNativeAutofill(
  target: BrowserEditingTarget | null,
  placement: NativeBrowserPlacement | null,
): boolean {
  const bridge = desktopBridge()?.browserPresentation;
  const { raised } = useNativeBrowserLayer();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const state = useSyncExternalStore<BrowserEditingState | null>(
    target?.subscribe ?? noSubscription,
    target?.get ?? noState,
    noState,
  );
  useAutofillResultNotice(target);
  const autofill = state?.autofill ?? null;
  const shown =
    !!placement &&
    !raised &&
    !!autofill &&
    autofill.open &&
    autofill.pending === null &&
    autofill.offer.geometryRevision === placement.geometryRevision;
  const offer = shown ? autofill.offer : null;
  const highlighted = autofill?.highlighted ?? 0;
  const viewportWidth = placement?.viewport.width ?? 0;
  const viewportHeight = placement?.viewport.height ?? 0;
  // The anchor is normalized to the page's view, which is laid out at this CSS size.
  const scene = useMemo<Omit<DesktopAutofillScene, "sceneRevision"> | null>(
    () =>
      offer && {
        accounts: offer.accounts.map(({ id, username, label }) => ({ id, username, label })),
        anchor: {
          x: offer.anchor.x * viewportWidth,
          y: offer.anchor.y * viewportHeight,
          width: offer.anchor.width * viewportWidth,
          height: offer.anchor.height * viewportHeight,
        },
        highlighted,
        reducedMotion,
        role: offer.role,
      },
    [offer, highlighted, reducedMotion, viewportWidth, viewportHeight],
  );

  const presentationId = placement?.presentationId ?? null;
  const presentationRevision = placement?.revision ?? null;
  const sceneRevision = useRef(0);
  // What main shows now, so the right presentation is told when it goes.
  const showing = useRef<{
    readonly presentationId: NativeBrowserPlacement["presentationId"];
    readonly revision: NativeBrowserPlacement["revision"];
    readonly sceneRevision: number;
  } | null>(null);
  const hide = useRef(() => {
    const shown = showing.current;
    showing.current = null;
    if (shown && bridge)
      bridge.setAutofill({
        presentationId: shown.presentationId,
        revision: shown.revision,
        scene: null,
      });
  });
  useEffect(() => () => hide.current(), [presentationId]);
  useEffect(() => {
    if (!bridge || !presentationId || presentationRevision === null) return;
    if (!scene) {
      hide.current();
      return;
    }
    const next = {
      presentationId,
      revision: presentationRevision,
      sceneRevision: ++sceneRevision.current,
    };
    showing.current = next;
    bridge.setAutofill({
      presentationId,
      revision: presentationRevision,
      scene: { ...scene, sceneRevision: next.sceneRevision },
    });
  }, [bridge, presentationId, presentationRevision, scene]);

  useEffect(() => {
    if (!bridge || !target || !presentationId) return;
    return bridge.onEvent((event) => {
      if (event.type === "key") {
        const autofill = target.get().autofill;
        if (showing.current && autofill) autofillKey(target, autofill, event.key);
      } else if (event.type === "autofill-choice") {
        if (
          event.presentationId === showing.current?.presentationId &&
          event.sceneRevision === showing.current.sceneRevision
        )
          target.fillAutofill(event.accountId);
      } else if (event.type === "autofill-dismiss") {
        if (event.presentationId === presentationId) target.dismissAutofill();
      }
    });
  }, [bridge, presentationId, target]);
  return shown;
}

function noSubscription(): () => void {
  return () => undefined;
}
function noState(): null {
  return null;
}
