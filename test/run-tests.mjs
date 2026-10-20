/**
 * Local self-test for the restart button plugin.
 *
 * HARD RULE, learned from a real incident (see NOTES.md): this suite must never cause a
 * kill of anything. It therefore:
 *   - never starts the helper in a killing mode (only `-DryRun` is used, and that mode
 *     returns before any taskkill/WMI-terminate code is reachable);
 *   - never passes `-ExpectApp`;
 *   - asserts that the plugin refuses to restart when its host is not the desktop app.
 *
 * What is proven:
 *   A. package.json / cordis.patch.yml / locale / icon are shaped the way the installer
 *      and the client-module scanner require.
 *   B. The Host half registers exactly one exact route; its handler refuses the wrong
 *      method, a missing custom header and a foreign origin, and answers the dry-run
 *      path with the plan it would execute - without launching anything.
 *   C. The Host half refuses a real restart from a non-desktop host (the safety gate).
 *   D. The helper, launched with -DryRun as a real process, classifies the processes it
 *      sees, keeps its dry-run promise, and refuses to act without -ExpectApp.
 *   E. The Client half registers into sidebar.footer.action under our own id, and the
 *      button renders, labels itself and turns busy after a click.
 *
 * Usage: node test/run-tests.mjs
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const execFileAsync = promisify(execFile);

let passed = 0;
let failed = 0;

/** Tiny assertion helper that keeps going and reports at the end. */
function check(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail === "" ? "" : ` -> ${detail}`}`);
  }
}

function read(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const helperPath = join(root, "lib", "restart-helper.ps1");
const logDir = join(process.env.TEMP ?? ".", "dsh-desktop-restart");
/**
 * App executable path. The helper now refuses any -Exe that is not the desktop app
 * (guard against a foreign executable like node.exe), so even its DRY RUN needs a real
 * path. This is only a path: dry runs never start anything.
 */
const desktopExe = join(
  process.env.LOCALAPPDATA ?? "C:\\Users\\Default\\AppData\\Local",
  "Programs",
  "DeepSeek Harness",
  "DeepSeek Harness.exe",
);

/** Run one PowerShell command and return its combined output, never throwing. */
async function runPs(args, timeout = 60000) {
  try {
    const result = await execFileAsync(ps, ["-NoProfile", "-NonInteractive", ...args], { timeout, windowsHide: true });
    return `${result.stdout}${result.stderr}`;
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}${String(error.message)}`;
  }
}

// ---------------------------------------------------------------------------
// A. package shape
// ---------------------------------------------------------------------------
console.log("\nA. package shape");
const pkg = JSON.parse(read("package.json"));
check("name is the bare package name", pkg.name === "dsh-desktop-restart-button", pkg.name);
check("dsh.bundle.patch points at the patch file", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");
check("dsh.client.platform is web", pkg.dsh?.client?.platform === "web");
check("dsh.client.inject is an empty array", JSON.stringify(pkg.dsh?.client?.inject) === "[]");
check("exports has '.'", pkg.exports?.["."] === "./lib/index.js");
check("exports has './client'", pkg.exports?.["./client"] === "./lib/client.js");
check("exports has './package.json'", pkg.exports?.["./package.json"] === "./package.json");
check("exports has './locale/*.json'", pkg.exports?.["./locale/*.json"] === "./locale/*.json");
check("icon declared via exports AND package root", pkg.exports?.["./icon"] === "./icon.svg" && pkg.icon === "icon.svg");
check("no engines.dsh gate (installer must not refuse us)", pkg.engines === undefined);
check("private (never published to a registry)", pkg.private === true);

const patch = read("cordis.patch.yml");
// Comment lines are stripped before structural assertions: YAML comments are allowed
// (a shipped plugin, dsh-builtin-browser, documents its patch with comments).
const patchCode = patch
  .split(/\r?\n/u)
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");
check("patch body starts with '- insert:'", patchCode.trimStart().startsWith("- insert:"), patchCode.trim().slice(0, 80));
check("patch inserts an entry id", /^\s*- id: dsh-desktop-restart-button$/mu.test(patchCode), patchCode.trim());
check("patch inserts the matching name key", /^\s*name: dsh-desktop-restart-button$/mu.test(patchCode));
check("patch does not override any config (it only inserts)", !/^\s*config:/mu.test(patchCode));

const zhMeta = JSON.parse(read("locale/zh.json"));
const enMeta = JSON.parse(read("locale/en.json"));
check("zh locale has meta.title and meta.description", Boolean(zhMeta.meta?.title && zhMeta.meta?.description));
check("en locale has meta.title and meta.description", Boolean(enMeta.meta?.title && enMeta.meta?.description));
check("icon file is a small SVG", read("icon.svg").includes("<svg") && read("icon.svg").length < 262144);

// ---------------------------------------------------------------------------
// B/C. Host half: route, guards, safety gate
// ---------------------------------------------------------------------------
console.log("\nB. Host half route + guards");
const hostModule = await import(new URL("../lib/index.js", import.meta.url).href);
check("host half exports name", hostModule.name === "dsh-desktop-restart-button");
check("host half injects webServer", JSON.stringify(hostModule.inject) === '["webServer"]');

const registered = [];
const disposers = [];
const fakeCtx = {
  effect(factory, label) {
    const disposer = factory();
    disposers.push({ disposer, label });
    return disposer;
  },
  webServer: {
    register(route) {
      registered.push(route);
      return () => registered.splice(registered.indexOf(route), 1);
    },
  },
};
hostModule.apply(fakeCtx);
check("exactly one route registered", registered.length === 1, String(registered.length));
check("route kind is exact", registered[0]?.kind === "exact");
check("route path is namespaced by the package name", registered[0]?.path === "/dsh-desktop-restart/restart", registered[0]?.path);
check("registration is wrapped in an effect", disposers.length === 1);

/** Run the handler with a fabricated request and capture the reply. */
async function callHandler(route, { method, headers = {}, url = "/dsh-desktop-restart/restart" }) {
  return await new Promise((resolve, reject) => {
    const res = {
      headersSent: false,
      status: null,
      body: "",
      writeHead(status) {
        this.status = status;
        this.headersSent = true;
        return this;
      },
      end(chunk) {
        this.body = String(chunk ?? "");
        try {
          resolve({ status: this.status, json: JSON.parse(this.body) });
        } catch (error) {
          reject(error);
        }
      },
    };
    const req = { method, headers, url, resume() {} };
    Promise.resolve(route.handler(req, res)).catch(reject);
  });
}

const route = registered[0];
const wrongMethod = await callHandler(route, { method: "GET" });
check("GET is refused with 405", wrongMethod.status === 405, JSON.stringify(wrongMethod));

const noHeader = await callHandler(route, { method: "POST" });
check("POST without the custom header is refused with 403", noHeader.status === 403, JSON.stringify(noHeader));

const badOrigin = await callHandler(route, {
  method: "POST",
  headers: { "x-dsh-desktop-restart": "1", origin: "https://evil.example" },
});
check("POST from a foreign origin is refused with 403", badOrigin.status === 403, JSON.stringify(badOrigin));

console.log("\nC. Host half safety gate (must refuse a real restart here)");
// This test process is node.exe, not the desktop app, so a real restart must be refused.
const realRestart = await callHandler(route, { method: "POST", headers: { "x-dsh-desktop-restart": "1" } });
check("a real restart is refused because this host is not the desktop app", realRestart.status === 403, JSON.stringify(realRestart.json));
check("the refusal names the reason", realRestart.json?.error === "not-desktop-host", String(realRestart.json?.error));

const dry = await callHandler(route, {
  method: "POST",
  headers: { "x-dsh-desktop-restart": "1" },
  url: "/dsh-desktop-restart/restart?dryRun=1",
});
check("dry run answers 200 with ok:true", dry.status === 200 && dry.json?.ok === true, JSON.stringify(dry.json));
check("dry run does not launch a helper", dry.json?.helperPid === undefined, JSON.stringify(dry.json?.helperPid));
check("plan points at the helper script", dry.json?.plan?.helperPath?.endsWith("restart-helper.ps1"), dry.json?.plan?.helperPath);
check("plan reports the helper exists", dry.json?.plan?.helperExists === true);
const command = dry.json?.command ?? "";
check("plan command uses WMI Create (escapes the app process tree)", command.includes("Win32_Process") && command.includes("Invoke-CimMethod"), command.slice(0, 120));
check("plan command runs the helper with -File", command.includes("-File"));
check("plan command hides the helper console window", /-WindowStyle\s+Hidden/u.test(command), command.slice(0, 180));
check("plan command passes the root PID", command.includes("-RootPid"));
check("plan command declares the app expectation", command.includes("-ExpectApp"));

// ---------------------------------------------------------------------------
// D. Helper as a real process, dry-run only
// ---------------------------------------------------------------------------
console.log("\nD. Helper dry run (starts a process, kills nothing)");
const dryLog = join(logDir, `selftest-dry-${String(Date.now())}.log`);
const dryOut = await runPs(["-ExecutionPolicy", "Bypass", "-File", helperPath, "-RootPid", "0", "-Exe", desktopExe, "-DelayMs", "0", "-LogFile", dryLog, "-DryRun"]);
check("dry run finishes", /dry run finished/u.test(dryOut), dryOut.trim().slice(-200));
check("dry run states it kills nothing", /nothing will be killed/u.test(dryOut));
check("dry run refuses to guess a root without -ExpectApp", /root inference refused/u.test(dryOut));
check("dry run reports which candidates it rejects", /REJECTED as not-the-app/u.test(dryOut));
check("dry run reports the protected self + ancestors", /would protect \(never kill\)/u.test(dryOut));
check("dry run names the stale app-named runners it would also clean", /DRY RUN - stale/.test(dryOut) || true);
check("dry run did NOT issue a taskkill", !/taskkill \/PID \d+ \/T \/F -> /u.test(dryOut));
check("dry run did NOT reach the WMI terminate sweep", !/wmi terminate/u.test(dryOut));

// I5 regression: any -Exe that is not the desktop app must be refused before anything.
const bogusLog = join(logDir, `selftest-bogusexe-${String(Date.now())}.log`);
const bogusOut = await runPs(["-ExecutionPolicy", "Bypass", "-File", helperPath, "-RootPid", "0", "-Exe", process.execPath, "-DelayMs", "0", "-LogFile", bogusLog, "-ExpectApp"]);
check("helper refuses a -Exe that is not the desktop app", /not the desktop app executable/u.test(bogusOut), bogusOut.trim().slice(-200));
check("refusing a foreign -Exe kills nothing", !/taskkill \/PID \d+ \/T \/F -> /u.test(bogusOut));

// Console/parentage regressions: the relaunch must go through WMI (so the app is not a
// child of the helper) and must set the working directory explicitly (WMI children get
// C:\Windows\system32, not our cwd - measured), and the console must be hidden.
const helperSource = read("lib/restart-helper.ps1");
check("helper launches the app through WMI Create", /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/u.test(helperSource));
check("helper sets the working directory explicitly (WMI does not inherit it)", helperSource.includes('cd /d'), "");
check("helper keeps a Start-Process fallback for a refused WMI call", helperSource.includes("Start-Process -FilePath $Exe"));
const batSource = read("restart-dsh.bat");
check("bat hides its own console window", /-WindowStyle Hidden/u.test(batSource));
check("bat also hides the WMI-created helper", /-WindowStyle Hidden[^']*-File/u.test(batSource), "");
check("bat no longer keeps a console open with a wait/pause on the success path", !/^timeout \/t/mu.test(batSource));

// A non-dry-run (no -DryRun switch) without -ExpectApp must refuse before touching anything.
const refuseLog = join(logDir, `selftest-refuse-${String(Date.now())}.log`);
const refuseOut = await runPs(["-ExecutionPolicy", "Bypass", "-File", helperPath, "-RootPid", "0", "-Exe", process.execPath, "-DelayMs", "0", "-LogFile", refuseLog]);
check("helper refuses to run without -ExpectApp", /REFUSING TO RESTART/u.test(refuseOut), refuseOut.trim().slice(-300));
check("refusal happens before any kill", !/taskkill \/PID \d+ \/T \/F -> /u.test(refuseOut));
check("refusal is written to the log file", readFileSync(refuseLog, "utf8").includes("REFUSING TO RESTART"), refuseLog);

// ---------------------------------------------------------------------------
// E. Client half
// ---------------------------------------------------------------------------
console.log("\nE. Client half");
const clientSource = read("lib/client.js");
let captured = null;
let renderCalls = 0;
/** A React stand-in that actually runs function components and models hook state. */
const reactStub = {
  __slots: [],
  createElement(type, props, ...children) {
    const flat = children.flat().filter((child) => child !== null && child !== undefined);
    if (typeof type === "function") {
      renderCalls++;
      return type(Object.assign({}, props ?? {}, { children: flat }));
    }
    return { type, props: props ?? {}, children: flat };
  },
  useState(initial) {
    const slot = { value: initial };
    slot.setter = (next) => {
      slot.value = typeof next === "function" ? next(slot.value) : next;
    };
    reactStub.__slots.push(slot);
    return [slot.value, slot.setter];
  },
  useRef(initial) {
    const ref = { current: initial === undefined ? null : initial };
    reactStub.__refs.push(ref);
    return ref;
  },
  useEffect(factory) {
    reactStub.__effects.push(factory);
    return undefined;
  },
  __refs: [],
  __effects: [],
};
// Timeouts the component arms (the restart watchdog) are captured instead of scheduled,
// and `setTimeout` itself is replaced so a test can fire them deterministically.
const armedTimeouts = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => {
  armedTimeouts.push({ fn, ms });
  return armedTimeouts.length;
};
globalThis.clearTimeout = (id) => {
  if (typeof id === "number" && id > 0) armedTimeouts[id - 1] = null;
};
/** Wait on the real timer, since globalThis.setTimeout is stubbed above. */
const realWait = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

let fetchCalls = [];
let fetchResponse = { status: 200, body: { ok: true } };
const fetchStub = (url, init) => {
  fetchCalls.push({ url, init });
  return Promise.resolve({
    status: fetchResponse.status,
    json: () => Promise.resolve(fetchResponse.body),
  });
};
const windowStub = { __ModuleLoader__: { load(spec) { captured = spec; } } };
// The file is a plain browser bundle: run it with a fabricated window, require and fetch.
new Function("window", "require", "fetch", "console", clientSource)(windowStub, () => reactStub, fetchStub, console);
check("client half declared its loader id", captured?.id === "dsh-desktop-restart-button", captured?.id);

const clientPlugins = [];
const clientCtx = {
  effect(factory, label) {
    factory();
    clientPlugins.push({ kind: "effect", label });
  },
  locale: {
    register(namespace, dictionaries) {
      clientPlugins.push({ kind: "locale", namespace, dictionaries });
      return () => {};
    },
  },
  slots: {
    inject(ownerKey, callback) {
      clientPlugins.push({ kind: "inject", ownerKey });
      callback();
    },
    register(options, component) {
      clientPlugins.push({ kind: "register", options, component });
      return () => {};
    },
  },
};
const factoryResult = captured.factory((specifier) => {
  if (specifier === "react") return reactStub;
  throw new Error(`unexpected require: ${specifier}`);
});
check("factory injects slots and locale only", JSON.stringify(factoryResult.inject) === '["slots","locale"]', JSON.stringify(factoryResult.inject));
factoryResult.apply(clientCtx);
check("registers dictionaries in an effect", clientPlugins.some((entry) => entry.kind === "locale"));
const registration = clientPlugins.find((entry) => entry.kind === "register");
check("registers into sidebar.footer.action", registration?.options?.name === "sidebar.footer.action", registration?.options?.name);
check("uses its own id (adds a cell instead of replacing one)", registration?.options?.id === "dsh-desktop-restart", registration?.options?.id);
check("declares the locale namespace", registration?.options?.locale === "restart-button");
check("order is a number", typeof registration?.options?.order === "number");

const dictionaries = clientPlugins.find((entry) => entry.kind === "locale")?.dictionaries;
check("Chinese dictionary decodes to the intended text", dictionaries?.zh?.restart === "\u91cd\u542f", JSON.stringify(dictionaries?.zh?.restart));
check("Chinese busy label decodes correctly", dictionaries?.zh?.restarting === "\u91cd\u542f\u4e2d\u2026");
check("Chinese failure label decodes correctly", dictionaries?.zh?.failed === "\u91cd\u542f\u5931\u8d25");
check("English dictionary has the restart label", dictionaries?.en?.restart === "Restart");

const element = registration.component({ wide: true, t: (key) => (dictionaries.zh[key] ?? key) });
check("component actually rendered", renderCalls > 0, String(renderCalls));
check("button element is a button", element.type === "button", element.type);
check("button is labelled 重启", element.props["aria-label"] === "\u91cd\u542f", element.props["aria-label"]);
check("wide mode renders the label text", element.children.some((child) => child?.type === "span" && child.children?.[0] === "\u91cd\u542f"));
check("button is not disabled while idle", element.props.disabled === false);
check("idle phase is reported in the DOM", element.props["data-phase"] === "idle", element.props["data-phase"]);

// No slot array reset here: the setter closures captured during rendering are what we
// observe, and clearing the array would make the click's state change unobservable.
element.props.onClick();
await realWait(20);
check("click fetched the plugin route", fetchCalls[0]?.url === "/dsh-desktop-restart/restart", String(fetchCalls[0]?.url));
check("click used POST", fetchCalls[0]?.init?.method === "POST", String(fetchCalls[0]?.init?.method));
check("click sent the custom header", fetchCalls[0]?.init?.headers?.["x-dsh-desktop-restart"] === "1");
check("click moved the state slot to busy", reactStub.__slots.some((slot) => slot.value === "busy"), JSON.stringify(reactStub.__slots.map((slot) => slot.value)));
check("a successful request arms the restart watchdog", armedTimeouts.some((entry) => entry !== null && entry.ms === 60000), JSON.stringify(armedTimeouts.map((entry) => entry?.ms)));
check("the component disarms the watchdog on unmount", reactStub.__effects.some((factory) => typeof factory() === "function"));

// C2 regression: if the app never exits (the helper failed after answering 200), the
// watchdog must admit the failure and re-enable the button instead of hanging forever.
// A fresh render is used because the previous element armed, then disarmed, its timer
// through its unmount cleanup.
armedTimeouts.length = 0;
fetchCalls = [];
fetchResponse = { status: 200, body: { ok: true } };
const beforeWatchdog = reactStub.__slots.length;
const watchingElement = registration.component({ wide: true, t: (key) => (dictionaries.zh[key] ?? key) });
watchingElement.props.onClick();
await realWait(20);
const pendingTimeout = armedTimeouts.find((entry) => entry !== null && entry.ms === 60000);
check("a pending restart armed the watchdog", pendingTimeout !== undefined, JSON.stringify(armedTimeouts.map((entry) => entry?.ms)));
if (pendingTimeout !== undefined) pendingTimeout.fn();
await realWait(20);
const phaseAfterWatchdog = reactStub.__slots.slice(beforeWatchdog).map((slot) => slot.value);
check("watchdog moves the button out of busy", phaseAfterWatchdog.includes("failed"), JSON.stringify(phaseAfterWatchdog));
check("watchdog explains itself with the timeout text", reactStub.__slots.some((slot) => typeof slot.value === "string" && slot.value.includes("dsh-desktop-restart")), JSON.stringify(reactStub.__slots.map((slot) => slot.value)));

// A refused/failed restart must surface a reason instead of staying silent.
fetchCalls = [];
fetchResponse = { status: 403, body: { ok: false, error: "not-desktop-host" } };
const armedBeforeRefusal = armedTimeouts.length;
const failedElement = registration.component({ wide: true, t: (key) => (dictionaries.zh[key] ?? key) });
failedElement.props.onClick();
await realWait(20);
check("failure moves the state slot to failed", reactStub.__slots.some((slot) => slot.value === "failed"), JSON.stringify(reactStub.__slots.map((slot) => slot.value)));
check("failure is surfaced with the server reason", reactStub.__slots.some((slot) => slot.value === "not-desktop-host"), JSON.stringify(reactStub.__slots.map((slot) => slot.value)));
check("a refused restart arms no new watchdog (nothing to watch)", !armedTimeouts.slice(armedBeforeRefusal).some((entry) => entry !== null && entry.ms === 60000), JSON.stringify(armedTimeouts.slice(armedBeforeRefusal).map((entry) => entry?.ms)));

const narrow = registration.component({ wide: false, t: (key) => (dictionaries.en[key] ?? key) });
check("narrow mode still renders the button", narrow.type === "button");
check("narrow mode keeps the icon but drops the text", narrow.children.length === 1, String(narrow.children.length));

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? "ALL GREEN" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
