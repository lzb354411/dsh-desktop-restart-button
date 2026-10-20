# 桌面端重启辅助（restart-helper）· 测试与排障记录

> 本文件记录**开发过程中的坑与事故**，不属于管理类文档（管理文档只有 `README.md`）。
> 证据分层：实测 > 代码事实 > 推断。

## 一、用户反馈的两个问题（2026-10-19 14:30，已修）

用户报告：① 出现黑色命令行窗口；② 曾在黑窗里重启 DSH 后黑窗还在，关掉它 DSH 也跟着关了；另一次关掉后 DSH 最小化到了托盘。

### 问题 1：黑色命令行窗口 —— **根因：助手没加隐藏参数**

WMI 创建的 PowerShell **默认带一个可见控制台窗口**。原 `lib/index.js` 的命令行只有 `-NoProfile -NonInteractive`，**没有** `-WindowStyle Hidden`。

**实测**：加 `-WindowStyle Hidden` 后，助手进程 `MainWindowHandle=0`（无可见窗口）；不加则有窗口。
**修复**：插件与 `restart-dsh.bat` 两处的启动命令都补上 `-WindowStyle Hidden`（助手与它创建的子助手都补）。
**真机复验**：走插件路由触发重启，运行期采到两个相关 PowerShell 进程 `MainWindowHandle=0`，**无可见窗口**。

### 问题 2：关掉黑窗 → DSH 也跟着关了 —— **根因：DSH 成了助手的子进程**

实测（对照实验，用 notepad 当替身）：

| 事实 | 实测结果 |
|---|---|
| 杀掉 `conhost`（等于关控制台窗口）会不会杀死 GUI 子进程？ | **不会**，`Start-Process` 与 WMI 两种方式拉起的 GUI 程序都活着 → 所以**不是**控制台连带 |
| `Start-Process` 拉起的程序的父进程是谁？ | **助手本身**（`Start-Process` 就设当前进程为父） |
| WMI 创建的程序的父进程是谁？ | `WmiPrvSE.exe`（在助手之外） |

**结论（推断 + 结构实测）**：旧代码用 `Start-Process` 启动 DSH，于是**DSH 挂在助手下面**。用户关掉黑窗时，助手进程结束；而重启流程一旦中断在"已经杀掉旧 DSH、还没启动新 DSH"之间，现象就是「DSH 也关了」。若助手是刚启动就被关，则时机会落在别处，表现为"最小化到托盘"。
**修复**：`Start-DesktopApp` 改用 **WMI 创建** DSH，使 DSH 的父是 `cmd.exe` 启动器（随即退出）而非助手 ⇒ 助手的生死与 DSH 解耦。

**真机复验（重启后现场实测）**：
```
DeepSeek Harness.exe(24272) <- <已退出:29608>        ← 父是已退出的 cmd 启动器，不是助手
根进程 MainWindowHandle=5441652（有主窗口）
根进程自己拥有的 conhost 数 = 0（不挂任何控制台）
日志：relaunch: WMI created the app launcher (PID 29608)
```

### 顺带修掉的两个连带问题

1. **`restart-dsh.bat` 成功路径上原本有 `timeout /t 8`**，强制把控制台窗口留 8 秒，等于"邀请"用户去点关闭——已删；成功即退出。
2. 旧 `.bat` 直接用当前窗口的 PowerShell 创建助手，助手是**这个控制台的子孙**；关窗同样会中止重启。现已改为：`.bat` 自身以 `-WindowStyle Hidden` 运行，且用它创建**隐藏的**助手。

### 这一轮新增的实测知识（记下来避免再踩）

| 项 | 实测结论 |
|---|---|
| WMI `Win32_Process.Create` 的工作目录 | **不继承调用者**，固定为 `C:\Windows\system32` ⇒ 必须显式设置（故 relaunch 命令用 `cmd.exe /c cd /d "<安装目录>" && start "" "<exe>"`，与桌面快捷方式等价：无参数、工作目录=安装目录） |
| `Win32_ProcessStartup`（唯一能传 StartupInfo 的入口） | **本机创建失败**，因此不用它 |
| WMI 创建的 GUI 程序是否带控制台 | **不带**（`conhost` 数 = 0） |
| `cmd.exe /c … start` 作为启动器是否弹黑窗 | **不弹**：cmd 自身 `MainWindowHandle=0`，约 0.3 秒即退出 |
| 关掉控制台是否连带杀 GUI 子进程 | **不连带**（所以"关窗致死"的真正原因是父子关系，不是控制台） |

## 二、事故记录（重要，含真实影响）

### 事故 1：自测脚本真的把正在运行的桌面端杀掉了（2026-10-19 03:33）

**经过**（全部来自日志原文 `%TEMP%\dsh-desktop-restart\restart-<时间戳>.log`）：

```
03:32:56 === restart helper started ===
03:32:56 params: RootPid=24432 Exe='C:\Program Files\nodejs\node.exe' DelayMs=1500 DryRun=False MyPid=24488
03:33:30 leftover sweep: 7 process(es) -> 12280,23508,4228,17752,22828,5504,10196
03:33:30 wmi terminate pid 12280 -> 0
03:33:32 relaunch: started 'C:\Program Files\nodejs\node.exe' with working directory 'C:\Program Files\nodejs'
03:34:03 WARNING: relaunch was issued but no app process appeared within 30s
```

**根因（三层，缺一不会出事）**：

1. 第一版自测**真的启动了助手**（而不是干跑），并且宿主是 `node.exe`（测试运行器）；
2. 助手由该 node 进程拉起，于是 `process.ppid` 指向一个**已退出**的 node 进程 → 助手据此推断的「根 PID」`24432` **根本不存在**（`taskkill` 两次报"没有找到进程 24432"）；
3. 根 PID 失效后，「等待进程归零」永远不成立，30 秒后走到**按进程名兜底清扫**，把当时正在运行的真实桌面端整棵树（`12280` 及其 6 个子孙）杀掉 → 桌面端真的重启了（进程表实测：旧根 12280，新根 **23680** 于 03:41:35 启动；GUI 端口 23655 → 28971）；助手随后试图用 `node.exe` 当桌面端启动，失败并放弃。

**影响**：用户当时正在使用的桌面端被**无预警重启一次**。没有安装任何东西、没有改动磁盘上任何配置；会话数据未发现丢失；DSH 已自动恢复正常运行。

**已经落地的修复（三条，缺一不可）**：

| 修复 | 位置 | 作用 |
|---|---|---|
| **安全闸门**：宿主不是桌面端时，拒绝执行真正重启（干跑保留） | `lib/index.js` `runningInsideDesktopApp()` + `handle()` | 从 node.exe / CLI 宿主触发的重启请求直接 `403 not-desktop-host`，助手根本不会被拉起 |
| **身份判据**：候选进程必须通过结构验证才可被杀（根 PID 必须是 app 进程、必须能由根子树或 shell 父子链解释） | `lib/restart-helper.ps1` `Test-IsAppProcess()` | 不再"按名字杀"，杜绝误杀同名进程（含桌面端自己的 node 运行器） |
| **期待闸门 + 禁止盲扫**：没有 `-ExpectApp` 或没有 app 进程时拒绝动手；**身份验证结果为空时，清扫一律不做** | `lib/restart-helper.ps1` 期待闸门 + `Remove-Leftovers()` | 断掉"根 PID 失效 → 退化为按名字杀"这条链路 |
| **根推断必须显式授权**：无根 PID 且无 `-ExpectApp` 时报 "root inference refused" | `Resolve-RootPid -ExpectApp` | 外部调用者不可能靠"推断"拿到根 |

**自测纪律（已写进测试文件头部）**：自测**只允许**用 `-DryRun`，**永不**传 `-ExpectApp`；并新增两条断言：宿主非桌面端时真实重启必须被拒、助手无 `-ExpectApp` 时必须拒绝动手。

### 事故 2（同类隐患，已消除）：`ELECTRON_RUN_AS_NODE` 会让"重启后没反应"

Host 子进程的环境里带着 `ELECTRON_RUN_AS_NODE=1`（`main.js:3649-3658` + `:3802-3811`），助手会继承它。
用它执行 `Start-Process <app>.exe` 会把桌面端启动成 **Node 模式**（无窗口、无 GUI），现象就是"点了重启但界面没回来"。
→ 助手启动前显式剔除该变量并记日志（`Start-DesktopApp`）。

## 三、取证过程中的关键坑（都已闭环）

| 坑 | 现象 | 结论 |
|---|---|---|
| asar 不是目录 | `Get-ChildItem ...\app.asar\dsh` 报路径不存在 | 用自写只读解析器 `%TEMP%\dsh-recon\asar.mjs`（`parse <asar> <cmd>`，**第一个参数是 asar 路径**） |
| 解析器参数顺序 | 少传 asar 路径时 `ENOENT ... open 'E:\...\find'` | 见上；不是脚本坏了 |
| `taskkill /T` 追不到孤儿 | 中间进程先退出后，孙进程存活且报 `not found` | 助手不依赖单次 `/T`：分级重试 + 身份验证后的逐个 WMI 终止 |
| 端口不能当判据 | Host 用 `--port 0`，实测端口每次不同（4207/9230/16164/23655，重启后 28971） | 「退干净」只能用**进程枚举**判断 |
| 按进程名杀很危险 | `DeepSeek Harness.exe` 有 8–9 个实例，其中 Host 的 node 运行器同名 | 身份验证 + 保护自身祖先链 |
| 插件无法请求壳层重启 | 穷举 5 张通道表 + 35 处 `ipcMain.handle`，零命中 | 必须外部助手（REFERENCES R1） |
| `cordis.patch.yml` 是硬门槛 | 官方安装器「没有组合包 patch 的依赖在安装前就被拒绝」 | 包内必须有 patch，且 `name` 必须等于包名 |

## 四、设计决策记录

| 决策 | 选择 | 代价 |
|---|---|---|
| 按钮位置 | `sidebar.footer.action`（list 槽，头像正上方） | 不是用户原话的"弹窗第一行"（官方弹窗写死了，无法插行） |
| 重启方式 | 外部助手强杀 + 重启（用户选②） | 跳过优雅停机，运行中任务被立即中断 |
| 确认框 | 不弹（用户选择） | 误点不可撤销；用"重启中…"禁用与 15s 冷却缓解 |
| 通信通道 | Host `webServer.register` + 页面同源 `fetch` | 鉴权自理：POST 限定 + 自定义头 + origin 防御 + 宿主身份闸门 |
| 助手脱离方式 | **WMI Create**（实测父进程 = `WmiPrvSE.exe`，逃过 `taskkill /T`） | 依赖 WMI 可用（Windows 标准组件） |
| 双保险 | 先按 PID 杀根（`/T /F`），不依赖名字 | 多一次进程枚举 |

## 五、独立审查结论与处置（2026-10-19）

由独立只读子代理对抗性审查，结论「**安全方向合格、功能方向不能直接交付**」：三道闸门确实堵死了事故链，但存在 2 条「应用已杀、却再也不会起来」的死路。逐条处置：

| 级别 | 问题 | 处置 |
|---|---|---|
| Critical 1 | `exit 4`（杀不干净就放弃）/ `exit 5`（启动没起来只报警）会让应用**死了不重开** | **已修**：仅当 `$state.RootAlive` 为真才拒绝重启（根死 ⇒ 锁必释放，必须重开）；启动改为 **20 秒×最多 6 次有界重试**，全败才 exit 7 并打印手工启动命令 |
| Critical 2 | 点了之后永停「重启中…」：收到 200 就没有超时，失败被静音 | **已修**：成功路径挂 **60 秒 watchdog**，超时转为「已失败 + 指向日志路径」，按钮恢复可点；卸载时清除定时器 |
| Important 1（闸门 A 可被绕过） | `dsh.cmd` 用 `ELECTRON_RUN_AS_NODE=1` 启动同一 app.exe，**进程名也叫 `DeepSeek Harness.exe`** ⇒ 单看 basename 会放行 CLI 宿主 | **已修**：闸门 A 追加「必须有父进程」；真正的结构校验放在助手侧（能读整张进程表） |
| Important 2（同名非根 PID 会被当根） | `process.ppid` 无指纹，PID 复用可能指向同名 node 运行器 ⇒ `/T /F` 打在无辜子树上 | **已修并实测**：助手要求根 PID **没有 app 名祖先**——拿真实的运行器 PID 23484 试，日志输出 `REFUSING TO RESTART: root PID 23484 has an app-named ancestor`，进程数保持 7 个不变 |
| Important 3（猜根被当事实） | 兜底「最早的 app 名进程」无结构验证 | **已修**：改为「无 app 名祖先者」，找不到就 `return 0`（不猜） |
| Important 4（断链孤儿不被判脏） | `/T` 追不到孤儿，残留进程不会被计入 dirty ⇒ 可能带着旧实例重启 | **已修**：新增 `Get-StaleAppProcesses`（父进程已非 app 名 ⇒ 视为残留），计入 `Test-AllGone` 与兜底清扫 |
| Important 5（冷却短于助手寿命） | 15 秒冷却 < 助手最坏约 77 秒 ⇒ 可并发两个助手抢同一根 | **已修**：冷却提到 90 秒 |
| Important 6（`-Exe` 不校验身份） | 传任意 exe 就能重现事故（正是 `node.exe`） | **已修**：`-Exe` 的基名必须是 `DeepSeek Harness.exe`，否则 exit 2 |
| Important 7（无「自己在树外」断言） | WMI 脱离是设计前提，却从不验证 | **已修并实测**：动手前沿父指针确认自己不在目标树内，日志出现 `self-location confirmed: helper PID … is not inside the target tree` |
| Minor | 缺 `-Protected` 的那次等待、`helperPid` 为空时回执仍 200、Web GUI origin 被拒（设计如此）等 | 已修等待参数与文档说明；其余保留（见下） |

**仍未做的两项（明确留档）**：
- `helperPid === null` 时仍回 `200`（只表示 WMI 没报回 PID，不代表失败）——已确认助手日志可事后判定，暂不改，避免把「WMI 没报 PID」误报成失败。
- 自托管 Web UI（`http://127.0.0.1:<port>`）点该按钮会被 `bad-origin` 拒——**这是设计意图**（防跨站），按钮只服务桌面页。

## 六、自测怎么跑

```
cd <插件项目目录>\dsh-desktop-restart-button
node test/run-tests.mjs
```

**88 项断言**，覆盖：包形态与 patch、Host 半边路由与三道守卫、**安全闸门（本机 node 宿主必须被拒）**、助手干跑（进程分类 / 不杀任何东西 / 拒绝无授权动手 / 拒绝非 app 的 `-Exe`）、Client 半边注册与按钮状态机（含 **watchdog 把按钮从 busy 拉回 failed** 这条 Critical 2 回归），以及本轮新增的 **console/parentage 回归**（助手启动命令必须带 `-WindowStyle Hidden`、relaunch 必须走 WMI、工作目录必须显式设置、成功路径不得留 `timeout` 等待）。
**该套件本身绝不杀进程**：只以 `-DryRun` 启动助手，且从不为助手提供杀进程所需的条件（不传 `-ExpectApp`、`-Exe` 用真实 app 路径但只干跑）。

## 七、真机验证记录（含全部修复）

**第一次（修复审查问题后）**，走**插件自己的 HTTP 路由**触发，日志 `%TEMP%\dsh-desktop-restart\restart-<时间戳>.log`：

```
expectation gate: app processes present = True, ExpectApp = True, root PID exists = True
self-location confirmed: helper PID 14160 is not inside the target tree of root 5256
taskkill /PID 5256 /T /F -> 成功: …（11 个进程逐层终止，含根 5256）
root is gone; waiting 2s for the app to finish flushing state
relaunch: started '…\DeepSeek Harness.exe' with working directory '…\DeepSeek Harness'
relaunch confirmed: 6 process(es) running, root candidate 16576
=== restart helper finished successfully ===
```

全程约 **7 秒**（04:07:29 → 04:07:36）；GUI 端口随之从 3213 变为 20475，说明整壳确实重启。

**第二次（修复用户反馈的「黑窗 + 关窗致死」后）**，日志 `%TEMP%\dsh-desktop-restart\restart-<时间戳>.log` 之后的最新一份（14:51 那次）：

```
self-location confirmed: helper PID 30200 is not inside the target tree of root 8116
taskkill /PID 8116 /T /F -> 成功: …（9 个进程逐层终止，含根 8116）
root is gone; waiting 2s for the app to finish flushing state
relaunch: WMI created the app launcher (PID 29608); command=cmd.exe /c cd /d "…\DeepSeek Harness" && start "" "…\DeepSeek Harness.exe"
relaunch confirmed: 1 process(es) running, root candidate 24272
=== restart helper finished successfully ===
```

同时实测到的关键旁证：
- 运行期两个相关 PowerShell 助手进程 `MainWindowHandle=0` ⇒ **无可见黑窗**；
- 重启后 `DeepSeek Harness.exe(24272)` 的父是**已退出的 cmd 启动器（29608）**，不是助手 ⇒ **助手的生死不再牵连 DSH**；
- 新根进程 `MainWindowHandle` 非 0（有主窗口）、自己拥有的 `conhost` 数 = **0**（不挂控制台）。
