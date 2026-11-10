export type BrowserInputMode = "editing" | "basic" | "none";

export function browserInputMode(editingVersion?: 1 | 2, basicInput?: 1): BrowserInputMode {
  return editingVersion ? "editing" : basicInput === 1 ? "basic" : "none";
}
