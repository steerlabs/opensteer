import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSContext } from "quickjs-emscripten-core";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { guestStringFits, guestStringUnits, readGuestString } from "./guest-strings.js";

const mebibyte = 1024 * 1024;
let vm: QuickJSContext;
beforeAll(async () => {
  vm = (await newQuickJSWASMModuleFromVariant(variant)).newContext();
});
afterAll(() => vm.dispose());

function guest(code: string) {
  return vm.unwrapResult(vm.evalCode(code));
}

it("refuses a string with more units than the limit has bytes without copying it", () => {
  using huge = guest('"x".repeat(64 * 1024 * 1024)');
  const copy = vi.spyOn(vm, "getString");
  try {
    expect(guestStringUnits(vm, huge)).toBe(64 * mebibyte);
    expect(readGuestString(vm, huge, mebibyte)).toBeUndefined();
    expect(guestStringFits(vm, huge, mebibyte)).toBe(false);
    expect(copy).not.toHaveBeenCalled();
  } finally {
    copy.mockRestore();
  }
});

it("admits a string whose worst case fits without measuring it", () => {
  using small = guest('"\\u{1F63A}é".repeat(1000)');
  const measure = vi.spyOn(Buffer, "byteLength");
  try {
    expect(readGuestString(vm, small, mebibyte)).toBe("\u{1F63A}é".repeat(1000));
    expect(guestStringFits(vm, small, mebibyte)).toBe(true);
    expect(measure).not.toHaveBeenCalled();
  } finally {
    measure.mockRestore();
  }
});

it.each([
  ["1,000,000 ASCII characters", '"x".repeat(1_000_000)', 1_000_000],
  ["600,000 é", '"é".repeat(600_000)', 1_200_000],
  ["300,000 surrogate pairs", '"\\u{1F63A}".repeat(300_000)', 1_200_000],
  // A lone surrogate is the worst case: three U+FFFD once on the Host.
  ["100,000 lone surrogates", '"\\uD800".repeat(100_000)', 900_000],
  ["120,000 lone surrogates", '"\\uD800".repeat(120_000)', 1_080_000],
])("measures %s exactly between the bounds", (_name, code, bytes) => {
  using value = guest(code);
  expect(Buffer.byteLength(vm.getString(value))).toBe(bytes);
  const fits = bytes <= mebibyte;
  expect(guestStringFits(vm, value, mebibyte)).toBe(fits);
  expect(readGuestString(vm, value, mebibyte)).toBe(fits ? vm.getString(value) : undefined);
});

it("reads nothing but strings", () => {
  using number = guest("42");
  expect(guestStringUnits(vm, number)).toBeUndefined();
  expect(readGuestString(vm, number, mebibyte)).toBeUndefined();
  expect(guestStringFits(vm, number, mebibyte)).toBe(false);
});
