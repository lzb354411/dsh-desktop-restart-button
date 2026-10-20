# 依据清单（REFERENCES）

> 证据分层：**实测** > **代码事实**（源码/官方文档原文，带 `路径:行号`） > **推断**。
> 所有「代码事实」均来自本机已安装的 DSH 0.2.1-rc.2，非网上二手资料。
> 采集时间：2026-10-19（Asia/Shanghai）。

## 一、关键结论速览

| 编号 | 结论 | 层级 |
|---|---|---|
| R1 | 桌面端**没有任何** IPC 让插件触发退出/重启：穷举 5 张通道表 + 35 处 `ipcMain.handle`，零命中 `quit`/`relaunch`/`restart`/`exit` | 代码事实 |
| R2 | 客户端→宿主端通信的第三方事实标准是 **Host `ctx.webServer.register()` + Client `fetch()`**；5/5 已装插件采用 | 代码事实 |
| R3 | 桌面页会把它**认识的静态资源之外的所有路径**转发给 Host 的 Web 服务器（无白名单），所以相对路径 `fetch` 能直达插件路由 | 代码事实 |
| R4 | 想往官方那个左下角头像弹窗里**插一行是不可能的**：4 行是官方账号插件里写死的数组，且所在槽 `settings.launcher` 是「单占位」槽 | 代码事实 |
| R5 | 官方为此留的正当位置是 `sidebar.footer.action`（**list** 槽，可并列追加，`id` 用自己的即新增格子） | 代码事实 |
| R6 | 插件包必须带 `cordis.patch.yml`，否则安装器在检查阶段直接拒绝 | 代码事实 |
| R7 | Host 子进程的环境里带 `ELECTRON_RUN_AS_NODE=1`，**会被插件继承**；用它去拉起 exe 会把桌面端启动成 Node 模式（等于不启动） | 代码事实 |
| R8 | Electron 单实例锁随进程终结由内核回收，强杀后立刻可重新启动 | 实测（等价模型） |
| R9 | 桌面端 Host 用 `--port 0`，端口每次启动都变 → **不能用端口判断"是否退干净"** | 实测 |
| R10 | 插件 Host 半边可以 `import 'node:*'`；**Client 半边不可以**（模块表只给 `react` 等少量种子） | 代码事实 |
| R11 | profile 目录里**没有** harness 运行时包（`@deepseek-ai` 下只有 `cosmokit`、`schemastery`）→ Host 半边不应 import 任何 `@deepseek-ai/*` | 实测 |

## 二、重启机制（为什么必须用外部助手）

### R1 插件无法请求壳层重启 —— 代码事实
- `app.asar/lib/main.js`（下称 `main.js`）`:3818-3837` 处理 Host 子进程 IPC，用 `isDesktopHostEvent`（`:3664`）校验。接受的 `type` 只有 `shutdown-complete`、`ready`、`platform-session`、`fatal` 或 requestId 回包；**其它一律** `this.fail(new Error("dsh desktop host sent an invalid IPC event"))` + `child.kill("SIGTERM")`。
- `DESKTOP_IPC` 25 项（`main.js:6981`，与 `preload-app.cjs:5-31` 同表）与 `PLATFORM_IPC` 5 项均为快捷键/boot/浏览器租约/目录选择/设备信息/语言/更新展示/外观/系统菜单，**无一条退出/重启/relaunch**。
- `createProductApi()`（`preload-app.cjs:789-843`）= `{protocolVersion, browser, deviceInfo, keyboard:{closeWindow,subscribe}, shortcuts, updates}`；`keyboard.closeWindow` 与 `dshPlatform.close` **只是关窗口**，关窗口=隐藏（`main.js:12894-12909`），进程照跑。
- 结论：**插件在进程内做不到"退全部进程再自动重开"**，必须由外部助手完成。这也解释了为什么用户选择的方案②（外部助手强杀进程树）不是取巧，而是唯一可行路径。

### R2/R3 Client→Host 通道 —— 代码事实
- `main.js:12406-12414` `protocol.handle(SCHEME, ...)`：主机名 `app` 时，`/`、`/index.html`、`/assets/`、`/favicon.svg`、`/manifest.webmanifest` 由壳层直接服务，**其余全部** `forwardWebRequest(request, hostUrl, hostCookie)` 转发给 Host。
- `forwardWebRequest`（`main.js:8268-8298`）：去掉 `host/origin/cookie/sec-fetch-site` 四个头，注入 host cookie 后 `fetch` 目标；非 `dsh-app://app` 的 Origin 直接 403。**没有路径白名单**（只有 `PLUGIN_BUNDLE_PATH` 命中时加 `cache-control: no-store`）。
- Host 侧路由 API：`@deepseek-ai/dsh-host-webserver/lib/index.js:326-333` `register(route)`：`route.kind === "exact"` 进 `exact` 表、否则 `prefix` 表；重复路径抛错；**返回 disposer**。形状 `{ kind, path, handler(req, res) }`，无 method 前缀（方法由 handler 自查 `req.method`）。
- 官方文档 `dsh-host-webserver/README.md:61/65/83`：`register`/`registerUpgrade`/`registerFallback`/`tapIndex` 均返回 disposer；`:130`「**No server-wide authentication or origin policy** — route owners such as `dsh-client-connection` enforce their own request policy」→ **鉴权必须自理**。
- 实物对照（5 个已装插件全部采用）：`dsh-balance-widget/lib/index.js`（`inject=["webServer"]`、`{kind:"exact", path:"/api/dsh-balance/balance", handler}`）+ `lib/client.js`（`await fetch(url)`）；`dsh-builtin-browser`、`dsh-client-auto-continue`、`@linxin666/dsh-remote-web-ui`、`@wingsky-1/dsh-notifier` 同构。
- 反面教材：`beauticode-dsh` 靠 `ctx.on("webserver/index-inject")` 自己往页面注入脚本。官方技能 `cordis-plugin-development/references/practices.md:33` 明确劝阻「不要从 Host 提供页面塞进 iframe」。**本项目不采用该路线**（但采用同一 injection 机制时要注意这条）。

### R4 头像弹窗插不了行 —— 代码事实
- 弹窗 4 行是**写死的数组**：`settings-account/lib/client.js:1871-1893` `items: [{id:"settings"},{id:"contact"},...signedIn?[{id:"signout"}]:[{id:"signin"}]]`，`onSelect` 在 `:1897-1907` 同样是写死的 if/else 链。
- 它挂在 `settings.launcher`，而该槽是 `kind:"single"`（目录 `dsh-cordis-client-runner/lib/client.js:5056-5083`），`occupants` 只有 `client-ui-settings-account AccountMenu`。
- 单占位槽只渲染第一个条目：`ui-renderer/lib/client.js:1173-1177` `if (spec.kind === "single") { const entry = host.entriesOfSlot(slotKey)[0]; if (!entry) return ... }`。
- 且后注册者**不是并列而是遮蔽**：目录 `:4864` 原文「This is a single slot, so a second entry does not sit beside the frame — it shadows it, and a dynamically registered entry is assigned a lower priority than the shipped one, which makes it the winner」。
- 结论：**「弹窗第一行是重启」只能靠整个替换官方头像菜单**，代价是重写登录/退出/额度提醒/头像加载等官方功能。用户已知情并选择改位置（见 SPEC 决策记录）。

### R5 替代位置 —— 代码事实
- `sidebar.footer.action`：`kind:"list"`、`scope:"root"`、summary「Optional actions beside Settings at the sidebar foot」（目录 `:5650-5675`）；`registerOptions` 含 `id`（required，**用自己的 id 即新增一个格子**）、`order`（default 0，升序）、`label`（`string | (() => string)`，thunk 每次投影重读 → 换语言无需重注册）；`ownerProps: {wide}`。
- 官方占用者：`client-ui-cordis CordisPanel id 'cordis-panel'`。
- 渲染处：`sidebar/lib/client.js:399-408` `footArea` 先 `renderSlot("sidebar.footer.action", {wide})` 再 `renderSlot("sidebar.settings", {wide})`。
- `settings.launcher` 就在同一列的紧下方（`settings-general/lib/client.js:435` 渲染 launcher，`:1233-1259` 声明 `settings.launcher`/`settings.trigger` 为 `sidebar.settings` 的子槽）→ 在 `sidebar.footer.action` 里注册即「头像正上方」，符合用户要的位置。

### R6 包形态与安装 —— 代码事实
- 官方模板 `agent-preset/cordis-plugin-development/templates/decoration/`：`package.json` 有 `dsh.bundle.patch`、`exports["./client"]`、`exports["./locale/*.json"]`、`exports["./icon"]`；`index.js` 只有 `export function apply(){}`；`client.js` 用 `window.__ModuleLoader__.load({id, factory(require){...}})` 包裹。
- `@deepseek-ai/dsh-package-manifest/README.zh.md:33-46` 官方示例：`dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' }, client }`；`:93`「当前安装器和加载器**不强制检查** `dsh.manifestVersion` 或 `engines.dsh`」→ 本包**故意不声明** `engines.dsh`，避免被版本门禁挡住（见 `dsh-plugin-manager` README 的「未满足的 DSH 版本要求会使操作失败」）。
- `dsh-plugin-manager/README.zh.md:171`「**没有组合包 patch 的依赖在安装前就被拒绝**」→ `cordis.patch.yml` 是硬门槛。
- 展示元信息键路径 = `locale/<lang>.json` 的 `{ "meta": { "title", "description" } }`（`dsh-client-ui-plugin-manager/locale/zh.json` 原文；README.zh.md:34）。
- 图标：读包根 `package.json.icon` **或** `exports["./icon"]`（README.zh.md:34）。
- 客户端半边的加载规则（`dsh-builtin-browser/cordis.patch.yml` 注释）：client-module 扫描把 loader 行的 specifier 解析到**包根**再读 `dsh.client`，**子路径行会被跳过** → 必须有一行 `name` 正好等于包名。本包 patch 的 `name` 即包名。
- 安装：`dsh/lib/bin.js:36` `error: profile "desktop" is managed exclusively by the Electron application`，只有 `manageDesktopProfile === true`（桌面端进程内）才放行 → 走官方插件页或 `plugin_manager` 工具，**不手改 profile 的 `package.json`/`cordis.patch.yml`、不在 profile 目录跑 pnpm**。
- 安装后改动：`dsh.profile.bundles`（追加包名）+ `dependencies`（追加 `file:` 绝对路径）+ `pnpm-lock.yaml`；`pnpm-workspace.yaml` 仅在 pnpm 拦构建脚本时追加授权。

### R7/R8/R9 外部助手 —— 代码事实 + 实测
- `main.js:3649-3658` `desktopNodeEnvironment()`：`{...environment, ELECTRON_RUN_AS_NODE: "1", ...}`；`:3802-3811` Host 子进程 `env: desktopNodeEnvironment(...)`。→ **Host 继承 `ELECTRON_RUN_AS_NODE=1`（代码事实）**；插件从 Host 拉起的助手若不剔除该变量，`Start-Process exe` 会把桌面端启动成 Node 模式。**这是本次实现中最隐蔽的坑**。
- `main.js:12812` 托盘退出 → `app.quit()`（**会**弹确认框，有活动任务时）；`:12775` 开发模式菜单「重启应用与 Host」用 `app.relaunch()+quitWithoutConfirmation()`，但 Windows 发行版菜单被 `refreshApplicationMenu()` 换成 `devToolsItems`，正式包**点不到**（`:12787-12799`）。
- 单实例：`main.js:7650-7665` `requestSingleInstanceLock()` 失败即 `application.quit()`。**实测**：运行中的 DSH 独占持有 userData `lockfile`（除 `FileShare.Delete` 外全部共享组合被拒）；等价模型下 `taskkill /F` 后句柄立即回收、可独占打开并删除 → **强杀后重新启动是安全的**（新实例能抢到锁）。
- **实测**：Host 用 `--port 0`，本次启动端口为 `4207 / 9230 / 16164 / 23655`（每次不同）→ 「是否退干净」的判据只能用**进程枚举**，不能用 TCP 端口。
- 进程树（实测）：根 `DeepSeek Harness.exe`（父 = explorer.exe）→ Host 子进程 + 5 个 `--type=` 辅助进程 + Host 的 runner 子进程；`taskkill /T` 按当前父子关系递归。

## 三、明确标注为「推断」或「未确证」的部分

| 项 | 状态 |
|---|---|
| 官方规范文档 `docs/cookbook/adding-a-package.zh.md` 全文（最小包完整示例、图标的**确切**文件名/格式/大小上限） | **未查到**：不在 app.asar、不在安装目录、不在 `~/.dsh`；随源码仓库发布，本机无源 |
| `dsh.client.inject` 的合法值集合 | 未确证（本包留空 `[]`，与 `dsh-balance-widget` 一致，实测该形状可安装运行） |
| `dsh.client.external` / `immediately` 的细节 | 未确证；5 个已装第三方插件**都没用**，本包不用 |
| Electron 单实例锁 = userData `lockfile` 的归属 | 推断（Chromium 常量 + Electron commit）；「强杀后释放」已由**等价模型实测**支撑 |
| `taskkill /T` 是否按启动时快照还是当前父子关系递归 | 未确证 → 助手因此采用「先杀 Host 断链、再扫名兜底、跳过自身与父进程」的双保险，不依赖单一语义 |
| 强杀会丢失哪些未落盘状态 | 推断（未能实测真实数据丢失） |
| `file:` 依赖在 `pnpm-lock.yaml` 里的确切记录形态 | 未确证（未读该文件） |

## 四、引用到的本机材料（路径索引）

- 安装目录（asar 归档，非目录）：`C:\Users\<你的用户名>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`
- 只读解析器（临时，非交付物）：`%TEMP%\dsh-recon\asar.mjs`
- 解出的参照文件：`%TEMP%\dsh-recon\extract\`（`app-lib\main.js`、`settings-account\lib\client.js`、`dsh-cordis-client-runner\lib\client.js`、`ui-renderer\lib\client.js`、`agent-preset\cordis-plugin-development\*`）
- 已装第三方插件（形态参照）：`<已装插件目录>\`
- 团队成员只读报告：`%TEMP%\dsh-recon-probe1\REPORT.md`（通道与骨架）、`%TEMP%\dsh-recon-probe2\REPORT-quit-restart-recovery.md`（退出/重启/锁）、`%TEMP%\dsh-pkg-probe\`（安装与清单规范）
- 官方技能原文（随 DSH 发布，非用户技能）：`cordis-plugin-development`、`editing-cordis-compositions`、`cordis-composition-reference`

## 五、许可证与再分发

- 本项目为**本机自用插件**，未复制任何 GPL/AGPL 代码。
- 代码形态参照的是**已装第三方插件的公开 API 用法**（`dsh-balance-widget` 等），只借鉴调用形状，未拷贝其实现。
- 引用的官方文档与源码仅用于本地取证，不再分发。
