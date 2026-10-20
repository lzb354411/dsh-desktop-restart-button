# dsh-desktop-restart-button

English ｜ [中文](README.md)

A Cordis plugin bundle for the **DeepSeek Harness desktop app**: it adds a **Restart** button at the sidebar foot, directly above the account avatar.

One click and the app **closes its window → exits every process → reopens by itself**, replacing the "right-click the tray icon and quit, then find the desktop icon and double-click" routine.

> The 30-second version: this is a "restart key" for the app. Normally you would quit from the tray and then relaunch by hand; now you press one button, and it reopens itself.

**License:** [MIT](LICENSE) ｜ **Platform:** Windows, DeepSeek Harness desktop `0.2.1-rc.2` (tested)

> ## ⚠️ Read before installing: the known cost
>
> **The restart is a force-kill, not a graceful quit.** Any running task is **interrupted immediately**, and state that was not flushed to disk can be lost.
>
> This is a deliberate trade-off. On quit, the desktop app shows a **native confirmation dialog** if it detects running or scheduled tasks — and a native dialog cannot be dismissed by an external process. A graceful path would therefore leave "one-click restart" stuck waiting for a human click. This plugin force-kills instead, so it works **unattended**. Finish any running task before pressing the button.

## Why it exists

The desktop app has no restart entry point of its own: the tray menu can only quit, and quitting means you have to relaunch manually — with a confirmation dialog in the way if a task is running. This plugin collapses "quit + relaunch" into a single click with no manual confirmation.

**Where the button sits, and why not where it was originally requested.** The original request was to put a row into the bottom-left avatar popup, as its first row. Investigation showed those popup rows are a **hardcoded array inside the official account plugin**, and the popup renders in a **single-occupancy slot** — a third-party plugin cannot add a row (registering there would *shadow* the entire official menu, login and logout included). With the user's agreement the button became a permanent entry **directly above the avatar**, which costs one *fewer* click. See `SPEC.md` and `REFERENCES.md` §R4/R5.

## How it works

```
"Restart" button in the page
   |  POST /dsh-desktop-restart/restart  (same-origin fetch)
   v
Plugin host half (runs inside the DSH Host process)
   |  creates the helper through WMI -> its parent is WmiPrvSE.exe, i.e. OUTSIDE the app's process tree
   v
Restart helper (standalone PowerShell process)
   1) kill the app root by PID together with its whole tree (taskkill /T /F)
   2) poll until the process table is genuinely empty
   3) strip ELECTRON_RUN_AS_NODE, then start the app again through WMI
```

Three decisions, each paid for with a measurement:

1. **Why an external helper is required.** The shell exposes **no IPC channel** through which a plugin can request a quit or a restart — exhaustively checked (5 channel tables plus all 35 `ipcMain.handle` registrations, zero hits). The click therefore has to be relayed to a process outside the app.
2. **Why the helper is created through WMI.** That makes its parent `WmiPrvSE.exe`, outside the app's process tree, so `taskkill /T` cannot reach it and it survives long enough to finish the restart.
3. **Why the relaunch also goes through WMI.** With `Start-Process` the app becomes a **child of the helper**, and the app dies as soon as the helper is killed — which is exactly what caused "closing the console window also closed the app". Through WMI the parent is a `cmd.exe` launcher that exits immediately, so the two are decoupled.

### Safety gates

The helper must pass three gates before it may kill anything. They exist because of a real incident: during development, a self-test script killed a running desktop app.

| Gate | What it does |
|---|---|
| Host identity | The plugin may only perform a real restart when it is genuinely running **inside the desktop app**; requests from a plain Node process or a CLI host are refused |
| Process identity | It never kills by name. A candidate must pass a structural check — the root must have **no app-named ancestor** — so the app's own Node runners (which share the executable name) are not killed |
| `-ExpectApp` expectation | Without an explicit "the app is running" declaration it refuses to act; when the identity check yields nothing, it performs **no sweep at all** |

## Install

It is a standard Cordis bundle, installed through the official plugin mechanism:

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "file:<path to this repository>"
```

Then **restart the desktop app once** so the plugin loads.

> **Re-install after changing code.** The copy under `node_modules` is a real copy, not a symlink,
> and `add` on an existing `file:` dependency makes pnpm print "Already up to date" **without recopying**.
> So to make an edit take effect you must **`remove` then `add`**.

## Uninstall

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop remove dsh-desktop-restart-button
```

## Manual restart (fallback, double-clickable)

- Inspect the plan only, kill nothing: `restart-dsh.bat --dry-run`
- Actually restart: `restart-dsh.bat`

The helper writes a log under `%TEMP%\dsh-desktop-restart\` on every run, with every command and its raw output.

## Layout

| Path | Role |
|---|---|
| `package.json`, `cordis.patch.yml` | bundle declaration and composition patch |
| `lib/index.js` | host half: registers the HTTP route, launches the helper |
| `lib/client.js` | page half: renders the Restart button (Chinese text is written as `\uXXXX` escapes so the file stays pure ASCII) |
| `lib/restart-helper.ps1` | the restart helper itself |
| `restart-dsh.bat` | double-click entry point (fallback) |
| `SPEC.md`, `PLAN.md`, `REFERENCES.md`, `NOTES.md`, `ACCEPTANCE.md` | requirements, plan, evidence (`path:line`), incident log, acceptance record (Chinese) |

## Tests

```powershell
node test/run-tests.mjs
```

**88 assertions** covering the package shape and patch, the host half's route and its three guards, the safety gates, a helper dry run, and the page half's button state machine (including a watchdog regression).

**The suite never kills a process**: the helper is only ever started with `-DryRun`, and it is never given what it would need to kill anything.

## Compatibility

- Targets the **Windows** DeepSeek Harness desktop app (`0.2.1-rc.2` measured).
- Requires the PowerShell and WMI that ship with Windows.
- It does **not** modify the DSH installation directory and does not touch the profile's `cordis.patch.yml`; uninstalling leaves nothing behind.
- The host half imports only `node:*`; the page half imports only `react`.

## License

[MIT](LICENSE)

## Credits

The code shape follows the public API usage of an installed third-party plugin (`dsh-balance-widget`) — only the calling shape was borrowed, no implementation was copied — plus the official plugin-development skill docs bundled with DSH.
