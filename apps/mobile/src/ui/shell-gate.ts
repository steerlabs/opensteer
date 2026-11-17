import { useIsFocused } from "@react-navigation/native";
import { useEffect } from "react";

/** Gates explaining a focused route; while any is up, the pill steps aside. */
const gates = new Set<object>();
const gateListeners = new Set<() => void>();
export const subscribeGates = (listener: () => void) => {
  gateListeners.add(listener);
  return () => gateListeners.delete(listener);
};
export const gated = () => gates.size > 0;
function changedGates(): void {
  for (const listener of gateListeners) listener();
}

/**
 * Said by a screen while it shows a gate, or a sheet that already explains the
 * connection: the pill would only repeat it.
 */
export function useShellGate(shown: boolean): void {
  const focused = useIsFocused();
  useEffect(() => {
    if (!shown || !focused) return;
    const token = {};
    gates.add(token);
    changedGates();
    return () => {
      gates.delete(token);
      changedGates();
    };
  }, [focused, shown]);
}
