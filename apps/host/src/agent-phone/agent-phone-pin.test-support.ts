import { randomInt } from "node:crypto";
import {
  eventually,
  type AndroidDevice,
  type Redaction,
} from "./agent-phone-device.test-support.js";

/** Staging and recovery only. The journey itself must unlock through phone tools. */
export async function stagePhonePin(device: AndroidDevice, redaction: Redaction) {
  const pin = String(randomInt(10_000_000, 100_000_000));
  redaction.add(pin);
  const delay = (await device.shell("settings get secure lock_screen_lock_after_timeout")).trim();
  const disabled = (await device.shell("locksettings get-disabled")).trim();
  if (!/^(?:null|[0-9]+)$/u.test(delay) || !/^(?:true|false)$/u.test(disabled)) {
    throw new Error("The dedicated device did not report its original keyguard settings");
  }
  let configured = false;
  const credential = async (command: string) => {
    try {
      return await device.shell(command);
    } catch {
      throw new Error("The dedicated device could not apply its temporary screen lock");
    }
  };
  const isLocked = async () => {
    const trust = await device.shell("dumpsys trust");
    const trustedState = /\bdeviceLocked=(true|false|1|0)\b/u.exec(trust);
    if (trustedState) return trustedState[1] === "true" || trustedState[1] === "1";
    const policy = await device.shell("dumpsys window policy");
    const state = /KeyguardServiceDelegate[\s\S]*?\bshowing=(true|false)/u.exec(policy);
    if (!state)
      throw new Error("The dedicated device did not report whether its keyguard is locked");
    return state[1] === "true";
  };
  const unlockScreen = async () => {
    await device.shell("input keyevent KEYCODE_WAKEUP");
    // The keyguard and its keypad are System UI's NotificationShade window; a
    // swipe sent before it takes focus is dropped.
    await eventually(
      "the keyguard to take focus before PIN recovery",
      async () =>
        /mCurrentFocus=Window\{[^}]*\bNotificationShade\}/u.test(
          await device.shell("dumpsys window"),
        )
          ? true
          : undefined,
      15_000,
    );
    await device.shell("input keyevent 82");
    const size = [...(await device.shell("wm size")).matchAll(/\b(\d+)x(\d+)\b/gu)].at(-1);
    if (!size) throw new Error("No display size during temporary PIN recovery");
    await device.shell(
      `input swipe ${Math.floor(Number(size[1]) / 2)} ${Math.floor(Number(size[2]) * 0.8)} ${Math.floor(Number(size[1]) / 2)} ${Math.floor(Number(size[2]) * 0.2)} 200`,
    );
    // Digits a stopped journey left in the entry would make this a wrong attempt.
    await device.shell(
      `input keyevent ${Array(pin.length * 2)
        .fill("KEYCODE_DEL")
        .join(" ")}`,
    );
    await credential(`input text ${pin}`);
    await device.shell("input keyevent KEYCODE_ENTER");
    await eventually(
      "temporary keyguard to unlock before clearing its PIN",
      async () => ((await isLocked()) ? undefined : true),
      15_000,
    );
  };
  const restore = async () => {
    try {
      if (configured) {
        let unlockFailure: unknown = null;
        try {
          // Android 11 retains the old PIN UI if the credential is cleared while it is showing.
          if (await isLocked()) await unlockScreen();
        } catch (error) {
          unlockFailure = error;
        }
        // Cleared even when the screen would not unlock: a dedicated device
        // never keeps a PIN nobody can read back.
        if (!(await credential(`locksettings clear --old ${pin}`)).includes("cleared")) {
          throw new Error("The dedicated device did not clear its temporary PIN");
        }
        configured = false;
        if (unlockFailure !== null) throw unlockFailure;
      }
    } finally {
      await device.shell(`locksettings set-disabled ${disabled}`);
      await device.shell(
        delay === "null"
          ? "settings delete secure lock_screen_lock_after_timeout"
          : `settings put secure lock_screen_lock_after_timeout ${delay}`,
      );
      await device.shell("input keyevent KEYCODE_WAKEUP");
      await device.shell("input keyevent 82");
    }
  };
  try {
    await device.shell("locksettings set-disabled false");
    await device.shell("settings put secure lock_screen_lock_after_timeout 0");
    if (!(await credential(`locksettings set-pin ${pin}`)).includes("set to")) {
      throw new Error("The dedicated device did not configure its temporary PIN");
    }
    configured = true;
    await device.shell("input keyevent KEYCODE_WAKEUP");
    await eventually(
      "phone to wake before power-lock",
      async () =>
        /mWakefulness=Awake/u.test(await device.shell("dumpsys power")) ? true : undefined,
      15_000,
    );
    // Power locks immediately; SLEEP follows the lock-delay path.
    await device.shell("input keyevent KEYCODE_POWER");
    await eventually(
      "power-lock to turn the screen off",
      async () =>
        /mWakefulness=Awake/u.test(await device.shell("dumpsys power")) ? undefined : true,
      15_000,
    );
    await eventually(
      "secure keyguard to lock while screen is off",
      async () => ((await isLocked()) ? true : undefined),
      15_000,
    );
    return { pin, restore, isLocked };
  } catch (error) {
    await restore();
    throw error;
  }
}
