---
name: devices
description: Connect, use, fix or remove devices on the person's network that can't run Opensteer (TVs, speakers, lights, cameras).
---

# Opensteer Devices

A device that can't run Opensteer is reached from one of the person's computers on its network,
through a local MCP server that talks to it. Settings › Devices lists the device once its server
declares it. Set it up in this task yourself rather than delegating, so the person's approvals and
its link to the device land here.

First list servers with `local_server_list`. If one already covers this device, use or fix it
instead of building another.

1. **Find it** from a computer on the device's network. The hosting computer runs your commands; the other-computers
   note names the rest. Browse Bonjour (`dns-sd -B _services._dns-sd._udp`), read the router's device
   list, or ask the person for its address. A laptop away from home sees another network; say so
   rather than guessing.
2. **Choose the simplest route that works:** the device's local protocol, the maker's documented API,
   or a maintained community library. A device only its maker's app can control is used through that
   app on an Agent Phone (opensteer:computer-use). Never reverse engineer an app or extract keys from
   one unless the person asks for it and accepts that the maker may block their account.
3. **Prove it from the shell:** a harmless read, then one reversible action the person would notice.
   Tell the person before installing tools on their computer, such as Python.
4. **Package it** as [local server](references/local-server.md) describes: a folder in Agent home
   with the server, one tool per action, and a skill that records the device's address, model and
   quirks. One server covers what the person would remove together, such as a stereo pair. Keep
   state such as pairing credentials in `PLUGIN_DATA`.
5. **Register it** with `local_server_add`: a specific name, the computer that reaches the device,
   the folder, the launch, secret names and the device. The person reviews the exact launch on that
   computer; if its tools then say access is needed, ask with `integration_request`. Its tools appear
   in `plugin_search` under that name, such as `tools["office-light"].on`; call them with
   `plugin_call` or `plugin_execute` by the exact path search returns.
6. **Codes the device shows,** such as a TV's pairing code, never go through chat. A server tool asks
   the person with MCP elicitation; they type the code on a card and only the server receives it.
7. **Verify** with the same reversible action through its tools. Then tell the person what you
   connected, which computer runs it, and that removing it deletes its pairing from that computer.

To fix a device, repair its folder and call `local_server_add` again with the same name. Remove it
with `local_server_remove` only when the person asks; Settings › Devices removes it too. Shell access
can still reach a device after removal or a refused launch; never use it to work around either.

- Read [device notes](references/device-notes.md) before connecting an Apple TV, HomePod or WiZ light.
- Read [local server](references/local-server.md) before writing the server.
