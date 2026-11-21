import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core";

// Measuring a guest string is the Host's work, never interpreted guest code
// charged to the guest's slice. A UTF-16 unit is at least one UTF-8 byte, so a
// string with more units than the limit cannot fit and is refused uncopied. A
// unit is at most 9 bytes once copied: QuickJS hands a lone surrogate out as 3
// bytes, which the Host decodes as three U+FFFD of 3 bytes each. So a string of
// at most `limit / 9` units always fits. Only between those bounds is the copy
// counted, and the copy is at most `limit` units.
const maxCopiedBytesPerUnit = 9;

/**
 * The UTF-16 length of a guest string primitive, read without copying it or
 * running guest code. Anything else, or a length that is not a safe
 * non-negative integer (as when reading it fails), is undefined: a refusal.
 */
export function guestStringUnits(vm: QuickJSContext, value: QuickJSHandle): number | undefined {
  if (vm.typeof(value) !== "string") return undefined;
  using length = vm.getProp(value, "length");
  const units = vm.getNumber(length);
  return Number.isSafeInteger(units) && units >= 0 ? units : undefined;
}

/** Whether the guest string's UTF-8 bytes on the Host fit `limit`. */
export function guestStringFits(vm: QuickJSContext, value: QuickJSHandle, limit: number): boolean {
  const units = guestStringUnits(vm, value);
  if (units === undefined || units > limit) return false;
  return units * maxCopiedBytesPerUnit <= limit || Buffer.byteLength(vm.getString(value)) <= limit;
}

/** The guest string, copied only when it can fit `limit` UTF-8 bytes, and only if it does. */
export function readGuestString(
  vm: QuickJSContext,
  value: QuickJSHandle,
  limit: number,
): string | undefined {
  const units = guestStringUnits(vm, value);
  if (units === undefined || units > limit) return undefined;
  const text = vm.getString(value);
  return units * maxCopiedBytesPerUnit <= limit || Buffer.byteLength(text) <= limit
    ? text
    : undefined;
}
