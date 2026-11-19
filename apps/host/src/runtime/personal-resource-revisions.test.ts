import {
  durablePersonalResourceKinds,
  PersonalResourceRevisionSchema,
  type DurablePersonalResourceRevisions,
} from "@opensteer/protocol/resources";
import { expect, test, vi } from "vitest";
import { ResourceRevisions } from "./personal-resource-revisions.js";

test("a restarted Host keeps durable revisions and never repeats a runtime one", () => {
  const durable = {
    ...(Object.fromEntries(
      durablePersonalResourceKinds.map((kind) => [kind, "0"]),
    ) as DurablePersonalResourceRevisions),
    settings: "4",
    machine: "9",
  };
  const first = new ResourceRevisions(() => undefined);
  first.seed(durable);
  first.bump("machine");
  const before = first.read(["settings", "machine"]);
  expect(PersonalResourceRevisionSchema.safeParse(before.machine).success).toBe(true);

  const changed = vi.fn();
  const second = new ResourceRevisions(changed);
  second.seed(durable);
  // Untouched by any runtime fact, a durable kind reads the same and is not reread.
  expect(second.get("settings")).toBe(before.settings);
  second.bump("machine");
  expect(second.get("machine")).not.toBe(before.machine);
  expect(changed).toHaveBeenLastCalledWith(new Set(["machine"]));

  // A commit raises the durable part; an older one reported late is ignored.
  second.committed(new Set(["settings"]), "12");
  second.committed(new Set(["settings"]), "11");
  expect(second.get("settings")).toBe("12");
});
