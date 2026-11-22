import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { CloudComputerAccount } from "../connections/account-cloud-computers.js";
import { CloudComputerClient, type CloudComputerSnapshot } from "../computers/cloud-computer.js";

const stores = new WeakMap<CloudComputerAccount, CloudComputerClient>();
const loading: CloudComputerSnapshot = {
  screen: { kind: "loading" },
  pending: null,
  actionFailure: null,
  checkoutFollowed: false,
  work: [],
  views: null,
};
const detachedSubscribe = () => () => {};
const detachedSnapshot = () => loading;

/** One store per Account, so every screen showing the Cloud Computer agrees. */
export function cloudComputerStore(account: CloudComputerAccount): CloudComputerClient {
  let store = stores.get(account);
  if (!store) {
    store = new CloudComputerClient({ account });
    stores.set(account, store);
  }
  return store;
}

/** Read while mounted; the platform calls `refresh` when the person comes back to the app. */
export function useCloudComputer(account: CloudComputerAccount | null) {
  const store = useMemo(() => (account ? cloudComputerStore(account) : null), [account]);
  useEffect(() => store?.start(), [store]);
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? detachedSubscribe,
    store?.getSnapshot ?? detachedSnapshot,
    store?.getSnapshot ?? detachedSnapshot,
  );
  return {
    ...snapshot,
    refresh: store?.refresh,
    act: store?.act,
    checkoutOpened: store?.checkoutOpened,
    stopFollowingCheckout: store?.stopFollowingCheckout,
    dismissFailure: store?.dismissFailure,
  };
}
