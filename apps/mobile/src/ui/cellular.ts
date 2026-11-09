import { NetworkStateType, useNetworkState } from "expo-network";

/** Whether the phone is on cellular data now, where every picture costs the person. */
export function useCellular(): boolean {
  return useNetworkState().type === NetworkStateType.CELLULAR;
}
