---
name: devices
description: Connect, use, fix or remove a device on the person's network that can't run Opensteer, such as a TV, speaker, light or camera.
---

# Opensteer Devices

A device that can't run Opensteer is reached from one of the person's computers on its network,
through an Agent Plugin whose local MCP server talks to it. Settings › Devices lists the device once
its plugin declares it. Set it up in this task yourself rather than delegating, so the person's
approvals and its link to the device land here.

First list plugins with `plugin_manage`. If one already covers this device, use or fix it instead of
building another.

1. **Find it** from a computer on the device's network. Main runs your commands; the other-computers
   note names the rest. Browse Bonjour (`dns-sd -B _services._dns-sd._udp`), read the router's device
   list, or ask the person for its address. A laptop away from home sees another network; say so
   rather than guessing.
2. **Choose the simplest route that works:** the device's local protocol, the maker's documented API,
   or a maintained community library. A device only its maker's app can control is used through that
   app on an Agent Phone (opensteer:computer-use). Never reverse engineer an app or extract keys from
   one unless the person asks for it and accepts that the maker may block their account.
3. **Prove it from the shell:** a harmless read, then one reversible action the person would notice.
   Tell the person before installing tools on their computer, such as Python.
4. **Package it** as opensteer:skills describes, with the shape in [plugin shape](references/plugin-shape.md):
   a specific name, a skill that records the device's address, model and quirks, a server with one
   tool per action, and the device declared in `plugin.json`. One plugin covers what the person would
   remove together, such as a stereo pair. Keep state such as pairing credentials in `PLUGIN_DATA`.
5. **Install** with `plugin_install`, then ask for access with `integration_request`. The computer's
   owner approves the server's launch from this task; its tools stay unavailable until then.
6. **Codes the device shows,** such as a TV's pairing code, never go through chat. A server tool asks
   the person with MCP elicitation; they type the code on a card and only the server receives it.
7. **Verify** with the same reversible action through the installed tools. Then tell the person what
   you connected, which computer runs it, and that removing it in Settings › Devices deletes its
   pairing from that computer.

To fix a device, read its plugin's folder and skill, repair it there and call `plugin_install` on the
same folder. To remove one, use `plugin_manage`. Shell access can still reach a device after its
plugin is removed or its launch is refused; never use it to work around either.

- Read [device notes](references/device-notes.md) before connecting an Apple TV, HomePod or WiZ light.
- Read [plugin shape](references/plugin-shape.md) before writing the plugin.
