# companion-module-kommander-t3

See [HELP.md](./companion/HELP.md) and [LICENSE](./LICENSE)

## Getting started

The module is plain JavaScript (Node 22), with no compile step. Run `yarn` to install the dependencies, then:

- `yarn test`: run the tests, which play Kommander's side with the messages Kommander 360 8.2 sends and accepts.
- `yarn format`: format the code with Prettier.
- `yarn check`: run Bitfocus' module checks.
- `yarn build`: build the package that Companion loads (`kommander-t3-<version>.tgz`).

To try it in Companion, put this folder in Companion's developer modules folder (set in the launcher's settings). Companion reloads the module when a file changes.

## Files

- `main.js`: connections to Kommander and its state.
- `central.js`: helpers for central control, Kommander's text protocol.
- `actions.js`, `feedbacks.js`, `presets.js`, `variables.js`: what the module offers in Companion. Buttons store the ids and options of actions and feedbacks, so those must not change; when they have to, add an upgrade script to `upgrade.js`.
- `tests/`: the tests, with stand-ins for `@companion-module/base`, `ws` and `node:net`.

## Kommander's protocols

The module uses both of Kommander's control interfaces. The tests in `tests/module.test.js` show the messages it uses.

- **WebSocket API**, port 1702: messages like `{"KommanderMsg": "KommanderMsg_<name>", "params": {...}}`, after a login (`KommanderMsg_Authentication`). Kommander answers with the same name and a `code` (1 is success), and it also sends notices when its state changes. It sends no state on connection, so the module asks for it once the media library is in.
- **Central control**, TCP port 5001: one text command per line, like `GlobalSet -mute on`, answered with `<command> -success`, `<command> -failed "<reason>"` or `<command> -<key> <value> ...`. After `SetHeartbeat -status on`, Kommander also sends a JSON heartbeat every 3 seconds. Kommander ends neither its replies nor its heartbeats with a newline, so `MessageReader` (in `central.js`) finds where each one starts. Kommander listens for central control only on the network card chosen in its Connection settings, not on 127.0.0.1. Kystar documents this protocol ("Kommander 字符串中控协议"). The commands that power off or restart machines and Kommander are deliberately left out.
