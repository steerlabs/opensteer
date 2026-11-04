import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { AppState, Pressable, ScrollView, Text, View } from "react-native";
import { BrowserPopupAnswerSchema, samePopup, type BrowserPopupRef } from "@opensteer/protocol";
import { browserPopupValueError, type BrowserPopupStore } from "@opensteer/client/host";
import { browserPopupNative } from "../../modules/browser-popup/index.js";

/** Native sheets own only a draft. The shared socket admission owns every answer. */
export function BrowserPopup({
  store,
  sessionId,
  surfaceId,
  active,
}: {
  store: BrowserPopupStore;
  sessionId: string;
  surfaceId: string;
  active: boolean;
}) {
  const target = useMemo(() => store.target(sessionId, surfaceId), [store, sessionId, surfaceId]);
  const view = useSyncExternalStore(target.subscribe, target.get);
  const native = browserPopupNative();
  const presentation = useRef<{
    id: string;
    popupId: string;
    revision: string;
    ref: BrowserPopupRef;
  } | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const dismiss = () => {
      ++generation.current;
      const old = presentation.current;
      presentation.current = null;
      if (old) void native?.dismiss(old.id).catch(() => undefined);
      target.release();
    };
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "active") dismiss();
    });
    return () => {
      listener.remove();
      dismiss();
    };
  }, [native, target]);
  useEffect(() => {
    if (!native) return;
    const listener = native.addListener("onAction", (event) => {
      const shown = presentation.current;
      const popup = target.get().popup;
      if (
        !active ||
        !shown ||
        shown.id !== event.presentationId ||
        shown.revision !== event.revision ||
        !popup ||
        !samePopup(shown.ref, popup.ref) ||
        popup.ref.revision !== event.revision
      )
        return;
      if (event.action === "cancel") {
        target.cancel(shown.ref);
        return;
      }
      const answer = BrowserPopupAnswerSchema.safeParse(event.answer);
      const error = !answer.success
        ? "This choice is invalid."
        : "value" in answer.data
          ? browserPopupValueError(popup.state, answer.data.value)
          : null;
      if (error || !answer.success) {
        void native
          .update(shown.id, shown.revision, {
            ...popup.state,
            notice: error ?? "This choice is invalid.",
          })
          .catch(() => target.cancel(shown.ref));
        return;
      }
      if (!target.answer(shown.ref, answer.data))
        void native
          .update(shown.id, shown.revision, {
            ...popup.state,
            notice: "That choice wasn't applied. Choose again.",
          })
          .catch(() => target.cancel(shown.ref));
    });
    return () => listener.remove();
  }, [native, target, active]);
  useEffect(() => {
    const popup = view.popup;
    if (!active || !popup || popup.state.kind === "datalist") {
      ++generation.current;
      const old = presentation.current;
      presentation.current = null;
      if (old) void native?.dismiss(old.id).catch(() => undefined);
      if (!active) target.release();
      return;
    }
    if (!native) {
      target.presentationFailed(popup.ref);
      return;
    }
    if (view.pending) return;
    const current = ++generation.current;
    const previous = presentation.current;
    const same = previous?.popupId === popup.ref.popupId;
    const id = same ? previous.id : crypto.randomUUID();
    if (previous && !same) void native.dismiss(previous.id).catch(() => undefined);
    presentation.current = {
      id,
      popupId: popup.ref.popupId,
      revision: popup.ref.revision,
      ref: popup.ref,
    };
    const show = same ? native.update.bind(native) : native.present.bind(native);
    void show(id, popup.ref.revision, {
      ...popup.state,
      ...(view.notice ? { notice: view.notice } : {}),
    })
      .then((ok) => {
        if (!ok && generation.current === current) target.presentationFailed(popup.ref);
      })
      .catch(() => {
        if (generation.current === current) target.presentationFailed(popup.ref);
      });
  }, [native, target, active, view.popup, view.pending, view.notice]);
  if (!active || !view.negotiated) return null;
  return (
    <View>
      {view.control === "other" ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => target.acquire()}
          style={{ padding: 12 }}
        >
          <Text>Take control</Text>
        </Pressable>
      ) : null}
      {view.control === "changing" ? (
        <Text accessibilityLiveRegion="polite">Control changed. Tap the page to continue.</Text>
      ) : null}
      {view.notice ? <Text accessibilityLiveRegion="polite">{view.notice}</Text> : null}
      {view.popup?.state.kind === "datalist" ? (
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          accessibilityRole="list"
          style={{ maxHeight: 120 }}
          contentContainerStyle={{ gap: 8, padding: 8 }}
        >
          {view.popup.state.items.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityState={{
                disabled: !item.enabled || view.pending,
                selected: view.highlighted === item.id,
              }}
              disabled={!item.enabled || view.pending}
              onPress={() => {
                const popup = target.get().popup;
                if (popup) target.answer(popup.ref, { itemIds: [item.id] });
              }}
              style={{ padding: 12, minHeight: 44, direction: item.rtl ? "rtl" : "ltr" }}
            >
              <Text>{item.label}</Text>
              {item.secondaryLabel ? <Text>{item.secondaryLabel}</Text> : null}
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={() => target.cancel()}
            style={{ padding: 12 }}
          >
            <Text>Dismiss</Text>
          </Pressable>
        </ScrollView>
      ) : null}
    </View>
  );
}
