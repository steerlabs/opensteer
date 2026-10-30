import { DictationController } from "@opensteer/client/dictation";
import { randomUUID } from "expo-crypto";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { dictationPort } from "../platform/dictation.js";
const Context = createContext<DictationController | null>(null);
export function DictationProvider({ children }: { children: ReactNode }): ReactNode {
  const [controller] = useState(
    () => new DictationController({ port: dictationPort, createId: randomUUID }),
  );
  useEffect(() => {
    void controller.refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void controller.refresh();
    });
    return () => {
      subscription.remove();
      controller.dispose();
    };
  }, [controller]);
  return <Context value={controller}>{children}</Context>;
}
export function useDictation(): DictationController {
  const controller = useContext(Context);
  if (!controller) throw new Error("DictationProvider is missing");
  return controller;
}
