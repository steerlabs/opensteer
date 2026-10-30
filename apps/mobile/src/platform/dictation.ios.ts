import { requireOptionalNativeModule } from "expo";
import { createDictationPort, type NativeDictation } from "./dictation-adapter.js";
const native = requireOptionalNativeModule<NativeDictation>("OpensteerDictation");
export const dictationPort = native === null ? null : createDictationPort(native);
