import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import { ViewNotMountedError } from "./view-not-mounted.js";

export { ViewNotMountedError };

/**
 * Calls to one of our native views' functions that never make the JavaScript thread wait for
 * the main thread.
 *
 * On iOS, Expo resolves a function's view argument on the JavaScript thread by waiting for the
 * main thread (`DynamicViewType.cast` → `AppContext.findView` → `DispatchQueue.main.sync`). While
 * React holds the main thread in a synchronous event beat waiting for JavaScript, that wait never
 * ends: the phone froze opening a page. A binary that declares `viewTagFunctions` instead offers
 * each function as `<name>ForView(tag, …)`, which takes the view's tag, a number, and finds the
 * view on the main queue it runs on. Android runs view functions on the main queue already and
 * resolves the view there, so its view functions stay; so do an older binary's.
 */

type ViewCall = (...args: never[]) => Promise<unknown>;

/** What a mounted native view instance carries: Expo's component sets `nativeTag` on mount. */
interface Tagged {
  readonly nativeTag?: number | null;
}

const declared = new Map<string, Record<string, unknown> | null>();

/** The module's tag functions, when this binary declares them; null otherwise. */
export function viewTagModule(moduleName: string): Record<string, unknown> | null {
  if (!declared.has(moduleName)) {
    const module =
      Platform.OS === "ios"
        ? requireOptionalNativeModule<Record<string, unknown>>(moduleName)
        : null;
    const version = module?.["viewTagFunctions"];
    declared.set(moduleName, typeof version === "number" && version >= 1 ? module : null);
  }
  return declared.get(moduleName) ?? null;
}

/** The view's tag, once Expo's component has mounted it; null before. */
export function viewTagOf(instance: unknown): number | null {
  const tag = (instance as Tagged | null)?.nativeTag;
  return typeof tag === "number" ? tag : null;
}

/**
 * The functions of a mounted view instance, called by its tag where the binary allows it, and as
 * the instance's own view functions where it does not. A view not mounted yet refuses the call.
 */
export function viewFunctionsOf<Calls extends Record<string, ViewCall>>(
  module: Record<string, unknown> | null,
  instance: Calls | null,
  names: readonly (keyof Calls & string)[],
): Calls | null {
  if (instance === null) return null;
  if (module === null) return instance;
  const calls: Record<string, ViewCall> = {};
  for (const name of names) {
    const byTag = module[`${name}ForView`];
    const own = instance[name] as ViewCall | undefined;
    calls[name] =
      typeof byTag !== "function"
        ? // The view's own function, called on the view (it reads the view's tag from `this`).
          ((typeof own === "function" ? own.bind(instance) : own) as ViewCall)
        : (...args: never[]) => {
            const tag = viewTagOf(instance);
            return tag === null
              ? Promise.reject(new ViewNotMountedError())
              : (byTag as (tag: number, ...rest: never[]) => Promise<unknown>)(tag, ...args);
          };
  }
  return calls as Calls;
}
