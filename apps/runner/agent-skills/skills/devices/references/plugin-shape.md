# Plugin shape

A device plugin is a folder in the task folder, named for the device:

```text
main-bedroom-apple-tv/
  plugin.json
  mcp.json
  server.py
  skills/main-bedroom-apple-tv/SKILL.md
```

`plugin.json` declares the device. `kind` is `tv`, `speaker`, `light`, `camera` or `other`; the name
is what the person calls it.

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "main-bedroom-apple-tv",
  "description": "Play, pause, open apps and power for the Apple TV in agent home Bedroom.",
  "extensions": {
    "com.opensteer": { "device": { "name": "Agent home Bedroom Apple TV", "kind": "tv" } }
  }
}
```

`mcp.json` starts the server on the computer that reaches the device:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "apple-tv": {
      "type": "stdio",
      "command": "uvx",
      "args": [
        "--python",
        "3.13",
        "--with",
        "mcp>=2,<3",
        "--with",
        "pyatv",
        "--with",
        "srptools<1",
        "python",
        "${PLUGIN_ROOT}/server.py"
      ],
      "env": { "PATH": "/opt/homebrew/bin:/usr/bin:/bin", "DEVICE_ADDRESS": "192.168.1.10" }
    }
  }
}
```

- `command` is a bare executable or a `./` path inside the plugin. The server starts with a minimal
  environment, so set `PATH` in `env` to the directory `command -v` shows for the launcher.
- Write state to the folder named by the `PLUGIN_DATA` environment variable. It survives updates and
  is deleted from that computer when the person removes the plugin.
- Give each action its own plainly named tool, such as `pause` or `launch_app`, that returns the
  device's new state. Mark reads as read-only.
- Test the server the way its computer will start it: launch the exact `command` and `args` from
  a small MCP stdio client, list its tools and call a read.
- If the shell reaches the device but the server can't, macOS may need Local Network access for
  Opensteer in System Settings › Privacy & Security › Local Network. Tell the person.

## Asking for a code

Pair from a tool that asks the person with MCP elicitation. With the Python MCP SDK 2.x, where
FastMCP is now `MCPServer`:

```python
from mcp.server.mcpserver import Context, MCPServer
from pydantic import BaseModel

mcp = MCPServer("apple-tv")

class Code(BaseModel):
    code: str

@mcp.tool()
async def pair(ctx: Context) -> str:
    pairing = await pyatv.pair(config, Protocol.Companion, asyncio.get_running_loop())
    await pairing.begin()
    answer = await ctx.elicit(message="Enter the code showing on the TV.", schema=Code)
    if answer.action != "accept":
        await pairing.close()
        return "Pairing didn't finish: the code wasn't entered."
    pairing.pin(int(answer.data.code))
    await pairing.finish()
    save_credentials(pairing.service.credentials)  # into PLUGIN_DATA
    return "Paired."
```

The card appears in the task that called the tool, and the code reaches only the server. Never
return or log the code. When the person can't answer in time, or the engine can't wait for a card,
the call reports that; tell the person and try again when they're ready.

Every elicitation field must be required.
