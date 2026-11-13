import { describe, expect, it } from "vitest";
import { sameLocalPath } from "./directory-links.js";

describe("sameLocalPath", () => {
  it.each([
    ["C:\\Users\\Person\\store", "c:\\users\\person\\STORE", true],
    ["\\\\?\\C:\\Users\\Person\\store", "C:\\Users\\Person\\store", true],
    ["\\??\\C:\\Users\\Person\\store\\", "C:\\Users\\Person\\store", true],
    ["C:/Users/Person/store", "C:\\Users\\Person\\store", true],
    ["C:\\Users\\Person\\store", "C:\\Users\\Person\\store2", false],
    ["D:\\Users\\Person\\store", "C:\\Users\\Person\\store", false],
    // A junction cannot name a share, so a share path is never read as a drive path.
    ["\\\\?\\UNC\\server\\share\\store", "\\\\server\\share\\store", false],
    ["\\\\server\\share\\store", "\\\\server\\share\\store", true],
  ])("on Windows, %s and %s are the same place: %s", (left, right, same) => {
    expect(sameLocalPath(left, right, "win32")).toBe(same);
  });

  it("compares POSIX paths exactly", () => {
    expect(sameLocalPath("/Users/person/store", "/Users/person/store", "darwin")).toBe(true);
    expect(sameLocalPath("/Users/person/store", "/users/person/store", "darwin")).toBe(false);
  });
});
