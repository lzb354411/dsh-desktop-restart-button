/**
 * Host 半边：把「重启」请求变成一次真实的「关闭 + 退出 + 自动重开」。
 *
 * 为什么需要外部助手（而不是在这里直接调 API）：
 *   取证结论 —— 桌面端没有任何 IPC 通道能让插件触发退出/重启（REFERENCES.md R1，
 *   穷举 5 张通道表 + 35 处 ipcMain.handle，零命中）。所以本模块只做两件事：
 *   1) 暴露一个 HTTP 路由，供页面半边调用（壳层会把非静态资源路径转发过来，R3）；
 *   2) 用 WMI 把一个「重启助手」进程甩到宿主进程树之外，然后立刻返回。
 *
 * 为什么用 WMI Create 而不是 spawn/Start-Process：
 *   实测（REFERENCES.md R2 附实测）——`Start-Process` 拉起的子进程仍在宿主击杀树内，
 *   会被 `taskkill /T /F` 连带杀掉；而 WMI Create 拉起的进程父进程是 `WmiPrvSE.exe`，
 *   **实测逃过 `/T` 递归**，正是「助手必须活到重启完成」这一需求所需要的。
 *
 * 本文件只依赖 `node:*`，不 import 任何 `@deepseek-ai/*`：
 *   profile 的 node_modules 里没有 harness 运行时包（REFERENCES R11），import 会解析失败。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

/** 插件名（与 package.json 的 name 一致）。 */
export const name = "dsh-desktop-restart-button";
/** 需要宿主提供的能力：只是嵌入式 Web 服务器（用于注册路由）。 */
export const inject = ["webServer"];

/** 路由路径。带包名前缀，避免与其他插件的路由撞车。 */
const ROUTE_PATH = "/dsh-desktop-restart/restart";
/** 自定义请求头：只有本插件的页面半边会带它（阻断跨站"简单请求"）。 */
const REQUEST_HEADER = "x-dsh-desktop-restart";
/** 助手启动后延迟多久开始动手，留出时间把 HTTP 回执发回页面。 */
const HELPER_DELAY_MS = 1500;
/** 两次重启请求之间的最短间隔（毫秒），防连点。
 *  助手最坏生存期约 (1.5s 延迟 + 45s 等待 + 6×20s 重试) ≈ 77 秒，冷却必须比它长，
 *  否则冷却一过可以再拉一个助手，两个助手会互相抢同一个根进程。 */
const MIN_INTERVAL_MS = 90000;
/** WMI 调用本身的超时（毫秒）。 */
const WMI_TIMEOUT_MS = 20000;
/** 桌面端可执行文件名；本插件只允许重启「这个应用」本身。 */
const DESKTOP_EXECUTABLE = "DeepSeek Harness.exe";

/**
 * 本进程是否真的跑在 DeepSeek Harness 桌面端里面？
 *
 * 这是本插件的**安全闸门**，起因于一次真实事故（见 NOTES.md 事故记录）：
 * 在普通 Node 进程里（测试运行器、`dsh web`、CLI 宿主），`process.execPath` 是
 * `node.exe`、`process.ppid` 也不是桌面端根进程，于是「推断出的根 PID」根本不存在；
 * 助手在根 PID 失效后按**进程名**兜底清扫，把当时正在运行的真实桌面端整棵树杀掉了。
 *
 * 因此：只有宿主确实由桌面端启动时，才允许执行会杀进程的动作。
 * 干跑（dryRun）不受此限制 —— 它不杀任何进程，是留给测试与排障的观察窗口。
 *
 * @returns 是桌面端宿主则为 true。
 */
function runningInsideDesktopApp() {
  if (basename(process.execPath).toLowerCase() !== DESKTOP_EXECUTABLE.toLowerCase()) return false;
  // 镜像名相同还不足以确认身份：`resources\runtime\cli\bin\dsh.cmd` 用
  // ELECTRON_RUN_AS_NODE=1 启动同一个 app.exe 跑 CLI 宿主，进程名**也**是
  // `DeepSeek Harness.exe`（实测该文件内容），单看 basename 会放行它。
  // 这里再要一个「宿主应当有父进程」的最低判据；真正的结构校验（根进程的父必须是
  // shell、助手自己必须在目标树之外）放在助手侧做，因为那里能读整张进程表。
  return Number.isSafeInteger(process.ppid) && process.ppid > 0;
}

/** 上一次被受理的重启请求时间（模块级，进程内生效）。 */
let lastRequestAt = 0;

/**
 * 定位本机 PowerShell 的绝对路径，找不到就退回 PATH 里的 `powershell.exe`。
 * @returns 可执行文件路径或裸命令名。
 */
function powershellPath() {
  const root = process.env.SystemRoot ?? process.env.windir ?? "";
  const absolute = root === "" ? "" : join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return absolute !== "" && existsSync(absolute) ? absolute : "powershell.exe";
}

/**
 * 把字符串转义成 PowerShell 单引号字面量。
 * @param value - 原始文本。
 * @returns 可安全嵌入 `'…'` 的文本（单引号加倍）。
 */
function psLiteral(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

/**
 * 描述这次重启计划（同时用于干跑验证，让"会杀谁、会启动谁"可以事先核对）。
 * @param helperPath - 助手脚本绝对路径。
 * @param logFile - 日志文件绝对路径。
 * @returns 计划对象；`rootPid` 为 0 表示需要助手自行推断根进程。
 */
function buildPlan(helperPath, logFile) {
  const exe = process.execPath;
  // 宿主进程的父进程就是桌面端的根进程（壳层用 spawn 直接拉起宿主）。
  const rootPid = Number.isSafeInteger(process.ppid) ? process.ppid : 0;
  return {
    helperPath,
    logFile,
    rootPid,
    exe,
    exeExists: existsSync(exe),
    helperExists: existsSync(helperPath),
    delayMs: HELPER_DELAY_MS,
  };
}

/**
 * 用 WMI Create 把助手甩到宿主进程树之外（实测父进程为 WmiPrvSE.exe，逃过 taskkill /T）。
 * @param plan - buildPlan 的产物。
 * @param dryRun - 为真时只拼命令、不执行。
 * @returns `{ command, helperPid }`；干跑时 helperPid 为 null。
 */
async function launchHelper(plan, dryRun) {
  const helperCommand = [
    powershellPath(),
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    // 关键：不加这一条，WMI 创建出来的 PowerShell 会带一个**可见的控制台窗口**
    // （用户看到的"黑色命令行窗口"）。实测加 -WindowStyle Hidden 后
    // MainWindowHandle=0，即无可见窗口。用户关掉那个窗口会连带杀掉助手。
    "-WindowStyle",
    "Hidden",
    "-File",
    `"${plan.helperPath}"`,
    "-RootPid",
    String(plan.rootPid),
    "-Exe",
    `"${plan.exe}"`,
    "-DelayMs",
    String(plan.delayMs),
    "-LogFile",
    `"${plan.logFile}"`,
    // 本插件只在自己确实跑在桌面端里时才走到这里（见 handle 里的安全闸门），
    // 因此有权声明「确认桌面端正在运行」——这是助手允许杀进程的前提。
    "-ExpectApp",
  ].join(" ");

  const wmiScript = [
    `$cmd = ${psLiteral(helperCommand)}`,
    "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }",
    "if ($r.ReturnValue -ne 0) { [Console]::Error.WriteLine('wmi-create-failed:' + $r.ReturnValue); exit 3 }",
    "[Console]::Out.WriteLine('helperPid=' + $r.ProcessId)",
  ].join("; ");

  if (dryRun) return { command: wmiScript, helperPid: null };

  const helperPid = await new Promise((resolve, reject) => {
    execFile(
      powershellPath(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", wmiScript],
      { timeout: WMI_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`wmi launch failed: ${String(error.message)} ${String(stderr).trim()}`.trim()));
          return;
        }
        const match = /helperPid=(\d+)/u.exec(String(stdout));
        resolve(match === null ? null : Number(match[1]));
      },
    );
  });
  return { command: wmiScript, helperPid };
}

/**
 * 路由处理器：校验来源 → 防连点 → 拉起助手 → 回执。
 * @param req - 宿主 Web 服务器的请求对象。
 * @param res - 宿主 Web 服务器的响应对象。
 * @param helperPath - 助手脚本绝对路径。
 */
async function handle(req, res, helperPath) {
  /** 统一的 JSON 回执。 */
  const send = (status, payload) => {
    if (res.headersSent === true) return;
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(payload));
  };

  // 只接受 POST：浏览器导航或图片标签都不可能触发 POST。
  if (req.method !== "POST") {
    send(405, { ok: false, error: "method-not-allowed" });
    req.resume?.();
    return;
  }

  // 自定义头：跨站"简单请求"带不了它，跨域带它就会先触发预检。
  if (req.headers[REQUEST_HEADER] !== "1") {
    send(403, { ok: false, error: "missing-request-header" });
    return;
  }

  // 纵深防御：壳层转发前会删掉 origin（REFERENCES R3 附 readWebRequest），
  // 因此这里通常看不到 origin；一旦看到且不是桌面页，说明请求来路不对。
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== "dsh-app://app") {
    send(403, { ok: false, error: "bad-origin" });
    return;
  }

  const url = new URL(req.url ?? ROUTE_PATH, "http://127.0.0.1");
  const dryRunRequested = url.searchParams.get("dryRun") === "1";

  // 安全闸门：非桌面端宿主一律拒绝真正重启（只允许干跑）。
  // 没有这道闸门时，从普通 Node 进程触发会杀错东西（见 runningInsideDesktopApp 说明）。
  if (!dryRunRequested && !runningInsideDesktopApp()) {
    send(403, {
      ok: false,
      error: "not-desktop-host",
      detail:
        "refusing to restart: this host process was not started by the desktop app, so the app's root process cannot be identified safely.",
    });
    return;
  }

  const logFile = join(tmpdir(), "dsh-desktop-restart", `restart-${String(Date.now())}.log`);
  const plan = buildPlan(helperPath, logFile);

  if (!plan.helperExists) {
    send(500, { ok: false, error: "helper-missing", detail: helperPath });
    return;
  }
  if (!plan.exeExists) {
    send(500, { ok: false, error: "executable-missing", detail: plan.exe });
    return;
  }

  // 干跑：只回报"准备做什么"，不真的重启（供测试与排障使用）。
  if (dryRunRequested) {
    const dry = await launchHelper(plan, true);
    send(200, { ok: true, dryRun: true, plan, command: dry.command });
    return;
  }

  const now = Date.now();
  if (now - lastRequestAt < MIN_INTERVAL_MS) {
    send(429, { ok: false, error: "already-requested" });
    return;
  }
  lastRequestAt = now;

  try {
    const { helperPid } = await launchHelper(plan, false);
    // 先回执、再由助手延迟动手（HELPER_DELAY_MS），确保页面能收到成功。
    send(200, { ok: true, plan, helperPid });
  } catch (error) {
    lastRequestAt = 0; // 失败不留冷却，允许立刻重试
    send(500, {
      ok: false,
      error: "launch-failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 插件入口：注册重启路由，并把释放交给 Cordis 的 effect 生命周期。
 * @param ctx - 宿主侧插件上下文。
 */
export function apply(ctx) {
  const helperPath = join(dirname(fileURLToPath(import.meta.url)), "restart-helper.ps1");
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: ROUTE_PATH,
        handler: (req, res) => void handle(req, res, helperPath),
      }),
    "dsh-desktop-restart-button: restart route",
  );
}
