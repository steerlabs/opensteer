import { phoneNoun } from "@opensteer/client/computers";
import { Platform } from "react-native";

/** What this phone is called where its name is not enough; the platform decides only the word. */
export const thisPhoneNoun = phoneNoun(Platform.OS === "ios" ? "ios" : "android");
