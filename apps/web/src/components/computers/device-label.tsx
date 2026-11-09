import type { DeviceElsewhere } from "@opensteer/client/computers";
import { Icon } from "../icon.js";
import { computerIcon } from "./device-art.js";

/** Where something lives, when that is not here: the device's shape and name, and Offline when it is. */
export function DeviceLabel({
  className,
  device,
}: {
  readonly className?: string;
  readonly device: DeviceElsewhere;
}) {
  const words = device.online ? device.name : `${device.name} · Offline`;
  return (
    <span className={className ? `device-label ${className}` : "device-label"} title={words}>
      <Icon name={computerIcon(device.glyph)} />
      <span className="device-label__name">{device.name}</span>
      {device.online ? null : <span className="device-label__away">· Offline</span>}
    </span>
  );
}
