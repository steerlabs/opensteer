import { useCallback, useEffect, useState } from "react";
import { randomUUID } from "expo-crypto";
import type { ViewProps } from "react-native";
import { PhoneBrowserHost } from "../../modules/phone-browser/index.js";
import type { PhoneBrowserManager, PhonePresentationAdmission } from "./manager.js";

export function PhoneBrowserTabHost(
  props: ViewProps & {
    readonly manager: PhoneBrowserManager;
    readonly admission: PhonePresentationAdmission;
    readonly onError: (error: unknown) => void;
  },
) {
  const { manager, admission, onError, ...viewProps } = props;
  const [hostId] = useState(randomUUID);
  const ready = useCallback(() => {
    void manager.presentTab(admission, hostId).catch(onError);
  }, [manager, admission, hostId, onError]);
  useEffect(
    () => () => {
      void manager.hideTab(admission.surfaceId, hostId).catch(onError);
    },
    [manager, admission.surfaceId, hostId, onError],
  );
  return (
    <PhoneBrowserHost {...viewProps} key={admission.surfaceId} hostId={hostId} onReady={ready} />
  );
}
