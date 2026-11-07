# Device notes

Notes for devices people often connect. Versions change; when a step fails, recheck the library's
current documentation before working around it.

## WiZ lights and plugs

WiZ devices take JSON over UDP on port 38899, with no account or pairing. Node's `dgram` is enough.

- `{"method":"getSystemConfig","params":{}}` names the model, such as `ESP25_SHRGB_01` for an RGB bulb.
- `{"method":"getPilot","params":{}}` reads the state: `state`, `dimming`, and either `r`/`g`/`b` or `temp`.
- `{"method":"setPilot","params":{"state":true,"dimming":60}}` changes it. Colour takes `r`, `g` and `b`
  from 0 to 255; white takes `temp` in kelvin.

Each device has its own address. Ask the router or the person for it, and suggest a DHCP reservation so
the plugin keeps finding it.

## HomePod and Apple TV

[pyatv](https://pyatv.dev) controls both from Python. With pyatv 0.18.0, use Python 3.13 and pin
`srptools<1`: Python 3.14 is unsupported and newer `srptools` fails during connection. For example:
`uvx --python 3.13 --with 'srptools<1' --from pyatv atvremote scan`. Tell the person before installing
Python tools on their computer.

- HomePods need no pairing for playback over AirPlay. A stereo pair is two HomePods with the same room
  name; connect them as one plugin, since the person removes them together.
- An Apple TV requires pairing for AirPlay and Companion, which together cover playback, apps and power.
  Pairing shows a four-digit code on the TV for about a minute. Pair each protocol the plugin uses and
  keep the credentials pyatv returns in `${PLUGIN_DATA}`.
- `atvremote scan` lists each device's model, address and whether pairing is mandatory, so read it
  before choosing what to build.
