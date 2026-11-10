import { describe, expect, it, vi } from "vitest";
import { barYield } from "./bar-title.js";

vi.mock("react-native", () => ({ Platform: { OS: "ios", select: () => undefined } }));
vi.mock("react-native-safe-area-context", () => ({}));
vi.mock("./pane.js", () => ({}));

describe("barYield", () => {
  // 375pt with Menu leading leaves 275 for a title and what trails it.
  const room = 275;

  it("gives way part by part until a short name reads whole", () => {
    // "Chat" beside a folded page and Around with places, tasks and schedules.
    expect(barYield({ freed: [36, 45], need: 105, room, trailing: 196 })).toBe(1);
    expect(barYield({ freed: [36, 45], need: 105, room, trailing: 160 })).toBe(0);
  });

  it("asks a long name for no more than its floor", () => {
    // A long task title's need is capped at the floor, so the same bar keeps every part.
    expect(barYield({ freed: [36, 45], need: 70 + 64, room, trailing: 130 })).toBe(0);
    expect(barYield({ freed: [36, 45], need: 70 + 64, room, trailing: 196 })).toBe(2);
  });

  it("stops when nothing more can give way, and the name truncates instead", () => {
    expect(barYield({ freed: [36], need: 200, room, trailing: 196 })).toBe(1);
    expect(barYield({ freed: [], need: 200, room, trailing: 196 })).toBe(0);
  });

  it("is short by any fraction of a point", () => {
    expect(barYield({ freed: [36], need: 105.2, room, trailing: 170 })).toBe(1);
  });
});
