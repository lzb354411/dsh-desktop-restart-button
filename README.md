> 本目录规则：`~/.dsh/AGENTS.md`（全局）+ `../AGENTS.md`（分类）；看不到分类规则时以本 README 与全局规则为准。

# dsh-desktop-restart-button（桌面端一键重启按钮）

**语言 / Languages：** 中文 ｜ [English](README.en.md)

给 **DeepSeek Harness 桌面端**加一个「重启」按钮：点一下即**关闭窗口 → 退出全部进程 → 自动重新打开**，
省掉「右键托盘图标选退出，再找到桌面图标双击打开」这两步。

> 比喻：这就像给电脑加了个「重启键」。平时要「开始 → 关机 → 再开机」，现在按一下就行；
> 区别是它会自己重新打开，不用你再去找图标。

许可证：[MIT](LICENSE) ｜ 平台：**Windows** 上的 DeepSeek Harness 桌面端（`0.2.1-rc.2` 实测）

> ## ⚠️ 装之前请读：已知代价
>
> **重启是「强杀」，不是「优雅退出」。** 正在跑的任务会被**立即中断**，未落盘的状态可能丢失。
>
> 这是**刻意的取舍**：桌面端退出时若检测到有活动/定时任务，会弹一个**原生确认框**，而原生框外部程序点不掉
> —— 走优雅退出的话，「一键重启」就会卡死在等人点确认。所以本插件走强杀，换来**无人值守也能用**。
> 点按钮前，建议先结束手头正在跑的任务。

## 一、项目说明

**解决什么问题**：桌面端本身没有「重启」入口，托盘菜单只能退出，退出后要手动再打开；若当时有任务在跑，还会弹确认框。
这个插件把「退出 + 重新打开」合成一次点击，且不依赖任何人工确认。

**给谁用**：本机自用（用户本人）。**为什么做**：省掉两步操作，且不必自己判断"是否真的退干净了"。

**位置说明**：用户最初要求按钮放进「头像弹窗的第一行」。取证结论是官方那个弹窗的 4 行**写死在官方账号插件里**，
第三方插件无法插入一行（它所在的槽是"单占位"槽，再注册是整块遮蔽官方菜单）。经用户确认改为**头像上方的常驻按钮**
—— 功能不变，还少一次点击。详见 `SPEC.md` 与 `REFERENCES.md` R4/R5。

**它在内部怎么工作**（每条都是实测换来的，细节见 `REFERENCES.md` / `NOTES.md`）：

```
页面「重启」按钮
   │  POST /dsh-desktop-restart/restart（同源 fetch）
   ▼
插件 Host 半边（跑在 DSH 的 Host 进程里）
   │  用 WMI 创建助手 → 助手父进程是 WmiPrvSE.exe，落在宿主进程树之外
   ▼
重启助手（独立 PowerShell 进程）
   1) 按 PID 杀掉桌面端根进程及其整棵树（taskkill /T /F）
   2) 轮询到进程表真的归零
   3) 剔除 ELECTRON_RUN_AS_NODE 后，经 WMI 重新启动桌面端
```

三个关键取舍：

1. **为什么必须有外部助手**：桌面端**没有任何 IPC 通道**能让插件触发退出/重启（已穷举 5 张通道表 + 35 处 `ipcMain.handle`，零命中）。
2. **为什么用 WMI 创建助手**：助手父进程因此是 `WmiPrvSE.exe`，**不在**宿主进程树里，`taskkill /T` 杀不到它 —— 它能活到重启完成。
3. **为什么重启也走 WMI**：用 `Start-Process` 会让桌面端成为**助手的子进程**，助手一结束桌面端就被牵连
   （这正是「关掉黑窗把桌面端也关了」的原因）。走 WMI 后父进程是随即退出的 `cmd` 启动器，两者解耦。

**三道安全闸门**（来自开发期一次真实事故：自测脚本误杀了正在运行的桌面端）：

| 闸门 | 作用 |
|---|---|
| 宿主身份校验 | 只在**自己确实跑在桌面端里**时才允许真实重启；从普通 Node 进程/CLI 宿主触发会被拒绝 |
| 进程身份验证 | 不按名字杀；根必须**没有** app 名祖先，避免杀掉同名的 Node 运行器 |
| `-ExpectApp` 期待闸门 | 未显式声明「确认桌面端在运行」时拒绝动手；身份验证结果为空时**一律不做清扫** |

## 二、怎么跑

**装进桌面端**（系统级操作，会影响所有工作区；本机已装）：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "file:<插件项目目录>/dsh-desktop-restart-button"
```

装完需要重启桌面端才会加载（第一次重启请用托盘退出后手动打开，或双击下面的 `restart-dsh.bat`）。

> **改了代码之后要重新装一遍。** 实测：`node_modules` 里落的是**真实副本**（不是软链）。
> 所以直接改项目里的 `lib/*.js` **不会**影响已装生效的那一份；且 `add` 同一个 `file:` 依赖时 pnpm 会说
> "Already up to date" **不会重新复制**。要让改动作生效，必须先 `remove` 再 `add`（本项目就是这样更新到 v1.0.1 的）。

**卸载 / 回滚（一键回到装之前）**：

```powershell
# 先只读确认它当前的状态：
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop why dsh-desktop-restart-button

# 摘掉：
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop remove dsh-desktop-restart-button
```

若需要"整体覆盖回滚"：用安装前的备份目录（含 6 个文件；同目录另有 `.bak-<备份时间戳>` 快回滚）。
回滚后 `dsh.profile.bundles` 应恢复为安装前基线，插件装在末尾。

**自测（不碰运行中的应用，只干跑）**：

```powershell
cd <插件项目目录>\dsh-desktop-restart-button
node test/run-tests.mjs
```

**手动重启（按钮失效时的兜底，可双击）**：

- 先看计划、不动手：`restart-dsh.bat --dry-run`
- 真重启：`restart-dsh.bat`

**日志**：助手每次运行都会在 `%TEMP%\dsh-desktop-restart\` 下留一份日志，含每步命令原文与输出。

**文件结构**：

| 路径 | 作用 |
|---|---|
| `package.json` / `cordis.patch.yml` | 插件包声明与组合补丁 |
| `lib/index.js` | Host 半边：注册 HTTP 路由、拉起助手 |
| `lib/client.js` | 页面半边：渲染「重启」按钮（中文以 `\uXXXX` 写死，保持文件纯 ASCII） |
| `lib/restart-helper.ps1` | 重启助手本体 |
| `restart-dsh.bat` | 双击入口（兜底用；`--dry-run` 只看计划） |
| `SPEC.md` / `PLAN.md` / `REFERENCES.md` / `NOTES.md` / `ACCEPTANCE.md` | 需求、方案、依据（带 `路径:行号`）、排障与事故记录、验收记录 |

## 三、开发计划与阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 找依据 | 取证：重启通道、槽系统、包形态、进程与锁机制 → `REFERENCES.md` | 已完成 |
| 1 需求 | `SPEC.md`（F1–F8 + 位置妥协记录） | 已完成 |
| 2 方案 | `PLAN.md`（架构、选型代价、11 步、风险登记） | 已完成 |
| 3 实现 | 插件包（Host 半边 / Client 半边 / 助手 / 双击入口） | 已完成 |
| 3.5 自测 | `test/run-tests.mjs`，**88 项断言全绿** | 已完成（88/88） |
| 3.5 事故修复 | 自测误杀真实桌面端 → 三道安全闸门 | 已完成（见 `NOTES.md`） |
| 4 审查 | 独立只读复核 → 2 Critical + 7 Important 全部修复并回归 | 已完成 |
| 4.5 用户反馈修复 | 黑窗 + 关窗连带关掉 DSH → 均已修复并真机复验（v1.0.1） | 已完成 |
| 5 验收 | 真机点击使用、对照 F1–F8 | **已完成（用户 2026-10-19 验收通过）** |
| 6 交付 | README/回滚说明 + 本地 commit + 脱敏后建远端仓库并推送 | 已完成 |

## 四、Agent 须知

- **本项目最重要的纪律：任何自测都不许真的杀进程。** 助手只允许以 `-DryRun` 启动，**永不**传 `-ExpectApp`。原因见 `NOTES.md` 事故 1（自测真的把运行中的桌面端杀掉过一次）。
- 助手的三道闸门不要试图绕过：`lib/index.js` 的 `runningInsideDesktopApp()`、助手的 `Test-IsAppProcess()` 身份验证、`-ExpectApp` 期待闸门。它们是那次事故的直接产物。
- **不要按进程名杀 `DeepSeek Harness.exe`**：桌面端的 node 运行器也叫这个名字；本机常有 8–9 个同名实例。
- **不要用 TCP 端口判断"退干净"**：Host 用 `--port 0`，端口每次启动都变。
- 重启桌面端**不要用** `resources\runtime\cli\bin\dsh.cmd`（它设 `ELECTRON_RUN_AS_NODE=1`，会起无窗口的 CLI 宿主）；要用安装目录下的 `DeepSeek Harness.exe`。
- 助手启动 exe 前必须剔除 `ELECTRON_RUN_AS_NODE`，否则桌面端会以 Node 模式启动（现象：重启后界面不回来）。
- **助手必须以 `-WindowStyle Hidden` 启动**，否则会弹出用户可见的黑窗口（用户反馈过）。
- **重启 DSH 必须走 WMI 创建，不能用 `Start-Process`**：后者会让 DSH 成为助手的子进程，助手一结束 DSH 就被牵连（用户反馈过「关掉黑窗 DSH 也关了」）。
- **WMI 创建的子进程不继承工作目录**（固定 `C:\Windows\system32`），必须用 `cmd /c cd /d "<安装目录>" && start "" "<exe>"` 显式设置。
- 插件代码形态参照 `dsh-balance-widget`：Host 半边只碰 `ctx`、`import` 仅用 `node:*`；Client 半边只 `require('react')`，**不要** `require('@deepseek-ai/dsh-client-ui-primitives')`（官方 `practices.md:35` 明确禁止，且 profile 里没有 harness 运行时包）。
- Client 半边里**不要写非 ASCII 字符**（中文一律用 `\uXXXX` 转义），避免加载器解码差异导致按钮不出现。
- **改动要生效必须先 `remove` 再 `add`**：`add` 同一个 `file:` 依赖时 pnpm 会说 "Already up to date" 而不重新复制文件。
- **提交前脱敏**：公开仓库里不要出现本机用户名、盘符绝对路径、私有项目名。本文档与其他文档中的机器相关路径一律用 `<你的用户名>` / `<插件项目目录>` 这类占位符。

## 五、下一步工作

- 无。本项目已验收通过。已完成的事：独立审查（2 Critical + 7 Important 全修）、用户反馈的黑窗与关窗连带问题（v1.0.1 修复）、脱敏建远端仓库并推送。
- 后续如需改动：改完按上方「怎么跑」里的 `remove` + `add` 重装，再点一次重启生效；改完记得跑 `node test/run-tests.mjs`（88 项应全绿）。
- 如按钮位置在真机上与「设置」拥挤，微调 `lib/client.js` 里的 `order` 与内边距。

## 六、Git 仓库约定

- 远端：GitHub 公开仓库（详见 `git remote -v`）；默认分支 `main`。
- 提交信息用中文一句话说明改了什么。本地 commit 免确认；**push 前先问用户**。
- 提交前自查：无密钥、无本机用户名/盘符绝对路径、无 `%TEMP%` 临时产物、无备份文件。
- 历史说明：本仓库曾为满足「公开仓库不泄露本机信息」的需求**重建过一次历史**（压成单条初始提交）；
  重建前的完整历史备份在 `<备份目录>\<备份时间戳>\...-git-history\`（仅本地保留，未推送）。

## 七、相关信息

- 依据清单（每条带 `路径:行号`，标注证据层级）：`REFERENCES.md`
- 需求与验收判据：`SPEC.md` ｜ 实施方案与风险：`PLAN.md`
- 坑与事故记录：`NOTES.md` ｜ 验收记录：`ACCEPTANCE.md`
- 参照的官方模板：DSH 安装包内 `cordis-plugin-development/templates/decoration/`
- 参照的已装插件：`dsh-balance-widget`、`dsh-builtin-browser`
- 许可证：MIT（见 `LICENSE`）；未复制任何 GPL/AGPL 代码，只借鉴了公开 API 的调用形状。
