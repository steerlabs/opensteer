import type { BrowserClientMessage } from "./browser.js";

export function browserBasicInputAllows(message: BrowserClientMessage): boolean {
  switch (message.type) {
    case "input.command":
      return message.command === "selectAll" || message.command === "deleteBackward";
    case "input.compose":
      return !message.composition.before && !message.composition.after;
    case "input.text":
      return message.edit.before === "" && message.edit.after === "";
    case "input.key":
      return (
        message.modifiers.length === 0 &&
        (message.location === undefined || message.location === 0) &&
        message.repeat !== true &&
        (((message.key === "Enter" || message.key === "Backspace") &&
          message.code === message.key &&
          message.text === undefined) ||
          (message.text !== undefined &&
            message.text === message.key &&
            !/\p{Cc}/u.test(message.text)))
      );
    case "input.pointer":
      return (
        (message.button === undefined || message.button === "left" || message.button === "none") &&
        (message.buttons === undefined || message.buttons <= 1) &&
        !message.modifiers?.length
      );
    case "input.wheel":
      return !message.modifiers?.length;
    case "clipboard.cut":
      return false;
    case "clipboard.paste-data":
      return (
        message.items.length === 1 &&
        message.items[0]?.type === "text/plain" &&
        message.items[0].name === undefined
      );
    default:
      return true;
  }
}
