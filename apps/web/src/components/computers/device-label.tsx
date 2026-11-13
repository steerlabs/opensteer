import type { DeviceElsewhere } from "@opensteer/client/computers";
import { Icon } from "../icon.js";
import { computerIcon } from "./device-art.js";

/**
 * Where something lives, when that is not here: the device's shape and name,
 * and Offline when it is. `iconOnly` keeps just the shape, for a dense list
 * whose row already says the name; pointer and screen reader still get it.
 */
export function DeviceLabel({
  className,
  device,
  iconOnly = false,
}: {
  readonly className?: string;
  readonly device: DeviceElsewhere;
  readonly iconOnly?: boolean;
}) {
  const words = device.online ? device.name : `${device.name} · Offline`;
  const classes = ["device-label", iconOnly ? "device-label--icon" : "", className ?? ""];
  return (
    <span className={classes.filter(Boolean).join(" ")} title={words}>
      <Icon name={computerIcon(device.glyph)} />
      {iconOnly ? (
        <span className="visually-hidden">{words}</span>
      ) : (
        <>
          <span className="device-label__name">{device.name}</span>
          {device.online ? null : <span className="device-label__away">· Offline</span>}
        </>
      )}
    </span>
  );
}
