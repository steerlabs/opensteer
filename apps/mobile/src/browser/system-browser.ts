import { Platform } from "react-native";

/** The system's own browser, as every menu that leaves for it says so. */
export const systemBrowserLabel = Platform.OS === "ios" ? "Open in Safari" : "Open in browser";
