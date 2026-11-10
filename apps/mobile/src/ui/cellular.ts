import { NetworkStateType, useNetworkState } from "expo-network";

/** Whether the phone is on cellular data now, where every picture costs the person. */
export function useCellular(): boolean | null {
  const { type } = useNetworkState();
  return type === undefined || type === NetworkStateType.UNKNOWN
    ? null
    : type === NetworkStateType.CELLULAR;
}
