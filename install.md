# Opensteer Install

Install Opensteer as a global tool:

```bash
uv tool install opensteer
opensteer skills install
opensteer --setup
```

Or use the installer:

```bash
curl -fsSL https://opensteer.com/install.sh | sh
```

## Verify

```bash
opensteer --doctor
opensteer -c "print(page_info())"
```

## Architecture

```text
Browser / Opensteer Cloud -> CDP websocket -> Opensteer daemon -> opensteer -c
```

- Protocol is one JSON line each way.
- `OPENSTEER_NAME` namespaces local session sockets and tab ownership state.
- `OPENSTEER_CDP_WS` attaches a session to a remote browser websocket.
- `OPENSTEER_BROWSER_ID` plus `OPENSTEER_API_KEY` lets the daemon stop a cloud browser on shutdown.

Editable installs are for Opensteer contributors. Normal harness packs depend on the installed package and CLI.
