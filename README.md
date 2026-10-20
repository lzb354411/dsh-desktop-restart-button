> 本目录规则：`~/.dsh/AGENTS.md`（全局）+ `../AGENTS.md`（分类）；看不到分类规则时以本 README 与全局规则为准。

# dsh-desktop-restart-button（桌面端一键重启按钮）

## 一、项目说明

给 DeepSeek Harness 桌面端加一个**「重启」按钮**，位置在侧栏左下角、**头像正上方**（与「设置」同一行区域）。

原本想重启要两步：右键托盘图标 →「退出」，再找到桌面图标双击打开。现在**点一下就完成**：
关闭窗口 → 退出全部进程 → 自动重新打开，回到原来的工作区。

给谁用：本机自己用（用户本人）。为什么做：省掉两步操作，且不必判断"是否真的退干净了"。

> 位置上的一处说明：用户最初要求按钮放进「头像弹窗的第一行」。取证结论是官方那个弹窗的 4 行**写死在官方账号插件里**，第三方插件无法插入一行（它所在的槽是"单占位"槽，再注册是整块遮蔽官方菜单）。经用户确认改为**头像上方的常驻按钮**——功能不变，还少一次点击。详见 `SPEC.md` 与 `REFERENCES.md` R4/R5。

## 二、怎么跑

**装进桌面端**（系统级操作，会影响所有工作区；本机已装）：

```powershell
& "C:\Users\<你的用户名>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "file:<插件项目目录>/dsh-desktop-restart-button"
```

装完需要重启桌面端才会加载（第一次重启请用托盘退出后手动打开，或双击下面的 `restart-dsh.bat`）。

> **改了代码之后要重新装一遍。** 实测：`node_modules` 里落的是**真实副本**（不是软链；`Get-Item` 的 `Attributes = Directory`、无 `LinkType`）。
> 所以直接改项目里的 `lib/*.js` **不会**影响已装生效的那一份；改完必须重跑一次上面的 `add` 命令（再重启桌面端）。
> 判断是否同步：比对 `lib\client.js` 的 SHA256，或直接重装。
>
> **重要**：`add` 同一个 `file:` 依赖时 pnpm 会说 "Already up to date" **不会重新复制**。
> 要让改动作生效，必须先 `remove` 再 `add`（本项目就是用这个办法更新到 v1.0.1 的）。

**卸载 / 回滚（一键回到装之前）**：

```powershell
# 不写改成什么、先看它当前是什么状态，可用 why 只读确认：
& "C:\Users\<你的用户名>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop why dsh-desktop-restart-button

# 摘掉：
& "C:\Users\<你的用户名>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop remove dsh-desktop-restart-button
```

若需要"整体覆盖回滚"，用安装前的备份：`<备份目录>\<备份时间戳>\Users\<你的用户名>\.dsh\profiles\desktop\`（6 个文件；同目录另有 `.bak-<备份时间戳>` 快回滚）。回滚后 `dsh.profile.bundles` 应恢复为 **21 项**（安装前基线，装在末尾；备份里的 `package.json` 可逐条比对）。

**自测（不碰运行中的应用，只干跑）**：

```powershell
cd <插件项目目录>\dsh-desktop-restart-button
node test/run-tests.mjs
```

**手动重启（按钮失效时的兜底，可双击）**：

- 先看计划、不动手：`restart-dsh.bat --dry-run`
- 真重启：`restart-dsh.bat`

**日志**：助手每次运行都会在 `%TEMP%\dsh-desktop-restart\` 下留一份日志，含每步命令原文与输出。

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
| 5 验收 | 真机点击使用、对照 F1–F8 | **已完成（用户 2026-10-19 17:23 验收通过）** |
| 6 交付 | README/回滚说明 + 本地 commit | 已完成 |

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
- 插件代码形态参照 `dsh-balance-widget`（最干净的最小样本）：Host 半边只碰 `ctx`、`import` 仅用 `node:*`；Client 半边只 `require('react')`，**不要** `require('@deepseek-ai/dsh-client-ui-primitives')`（官方 `practices.md:35` 明确禁止，且 profile 里没有 harness 运行时包）。
- Client 半边里**不要写非 ASCII 字符**（中文一律用 `\uXXXX` 转义），避免加载器解码差异导致按钮不出现。
- **改动要生效必须先 `remove` 再 `add`**：`add` 同一个 `file:` 依赖时 pnpm 会说 "Already up to date" 而不重新复制文件。

## 五、下一步工作

- 无。本项目已验收通过。已完成的事：独立审查（2 Critical + 7 Important 全修）、用户反馈的黑窗与关窗连带问题（v1.0.1 修复）。
- 后续如需改动：改完按上方「怎么跑」里的 `remove` + `add` 重装，再点一次重启生效；改完记得跑 `node test/run-tests.mjs`（88 项应全绿）。
- 如按钮位置在真机上与「设置」拥挤，微调 `lib/client.js` 里的 `order` 与内边距。

## 六、Git 仓库约定
- 本机新建 `git init`，无远程仓库、不走 PR（自用插件，暂不发布）。
- 提交信息用中文一句话说明改了什么。本地 commit 免确认。
- 提交前自查：无密钥、无 `%TEMP%` 临时产物、无备份文件。

## 七、相关信息

- 依据清单（每条带 `路径:行号`，标注证据层级）：`REFERENCES.md`
- 需求与验收判据：`SPEC.md` ｜ 实施方案与风险：`PLAN.md`
- 坑与事故记录：`NOTES.md`
- 参照的官方模板：DSH 安装包内 `cordis-plugin-development/templates/decoration/`
- 参照的已装插件：`dsh-balance-widget`、`dsh-builtin-browser`（两者都在 `<已装插件目录>\`）
