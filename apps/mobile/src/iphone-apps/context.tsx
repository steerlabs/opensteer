import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { IphoneAppsController, IphoneAppsState } from "./controller.js";

const IphoneAppsContext = createContext<IphoneAppsController | null>(null);

/** The one controller for this iPhone's apps, built at the composition root. */
export function IphoneAppsProvider(props: {
  readonly children: ReactNode;
  readonly controller: IphoneAppsController;
}): ReactNode {
  return (
    <IphoneAppsContext.Provider value={props.controller}>
      {props.children}
    </IphoneAppsContext.Provider>
  );
}

export function useIphoneApps(): IphoneAppsController {
  const controller = useContext(IphoneAppsContext);
  if (controller === null)
    throw new Error("This screen was rendered outside the Opensteer app root.");
  return controller;
}

export function useIphoneAppsState(controller: IphoneAppsController): IphoneAppsState {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}
