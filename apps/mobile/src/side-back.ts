import {
  useNavigation,
  useNavigationState,
  usePreventRemove,
  useRoute,
} from "@react-navigation/native";
import { isTeamSideRoot, sideMemory } from "./side-memory.js";

export function useTeamSideBack(): void {
  const navigation = useNavigation();
  const { key } = useRoute();
  const root = useNavigationState((state) => isTeamSideRoot(state, key));
  usePreventRemove(root, ({ data }) => {
    if (["GO_BACK", "POP", "POP_TO_TOP"].includes(data.action.type)) {
      const state = navigation.getState();
      const action = state === undefined ? null : sideMemory.back(state);
      if (action !== null) {
        // Preserve React Navigation's visited-route marker when redirecting Back.
        navigation.dispatch({ ...data.action, ...action });
        return;
      }
    }
    navigation.dispatch(data.action);
  });
}
