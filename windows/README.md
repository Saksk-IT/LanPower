# Windows 应用

运行中的“已处理时间”移至本轮工作内容开头；完成后的查看图片记录与过程插图收进整轮“用时…”入口，展开可查看完整过程和图片预览。Windows / Cloud / Web `1.18.3`，小程序 `3.0.4`；说明见 [整轮工作过程](../docs/codex-conversation-ui.md)。

`1.18.3` 安装器注册登录后自动启动和每分钟恢复的后台任务；原 Codex 窗口断开后自动重连，无需打开 LanPower 界面。开机后仍需登录 Windows，并打开已登录、已启用本机连接的官方 Codex。详见 [自动启动与重连](../docs/codex-windows-startup.md)。

工作过程图片已增加折叠标题：默认收起，展开显示 140×140 等比例缩略图，点击可查看大图。Windows / Cloud / Web `1.18.3`，小程序 `3.0.4`；行为和验证见 [图片折叠预览](../docs/codex-image-preview.md)。

`1.18.3` 修复 Codex Remote 的大项引用生命周期、稳定轮次历史操作、Unicode 输入计量、公开工具过滤和完整授权聊天目录。升级保留原配置和设备身份，详见 [首批六项修复](../docs/codex-remote-first-six-fixes.md)。

Codex Remote 已解除单控制页面限制：多个网页和小程序可同时连接同一电脑，任务与审批状态同步，关闭一个页面不影响其他页面。版本与验证见 [多页面控制](../docs/codex-multiple-pages.md)。

当前源码版本：Windows `1.18.3`；当前公开安装器和便携包仍见 [v1.6.1 发布页](https://github.com/Saksk-IT/LanPower/releases/tag/v1.6.1)。Host 修复大图片导致整轮隐藏，稳定复用内容引用；网页自动恢复正文、图片及完整工具输出，详见 [完整会话显示](../docs/codex-history-content.md)。既有发送回执、状态版本及原生控制恢复继续保留，见 [P0 验收记录](../docs/codex-remote-p0.md)。小程序 `3.0.4` 通过 Cloud `1.18.3` 连接既有用户 Codex Host，无需新增 Windows 入站端口。用户登录和项目授权继续适用；会话展示见 [说明](../docs/codex-conversation-ui.md)，本机更新记录见 [开发指南](../docs/local-development.md)。现有三色托盘和电源功能见 [v1.7 升级说明](../docs/upgrade-v1.7.md)。

微信小程序 `3.0.4` 已接入完整远程控制接口，使用原生界面与独立状态控制器；详见 [小程序重构说明](../docs/codex-remote-mini-program.md)。本轮只更新本机 Docker 与 Windows，保留设备身份、配对和开发授权。

原窗口整合新增「连接原 Codex 窗口」，直接连接当前用户的官方窗口并沿用它的服务。无需另开工作窗口；原生任务、审批与队列共享。原服务审批回复已经通过真实任务验证，备用服务入口保留为「打开备用共享窗口」。见 [原窗口整合说明](../docs/codex-original-window.md)。

本目录是 .NET 10 Windows 服务、WPF 桌面端和安装包的源码。服务同时提供 LAN Direct 与可选的 Cloud Direct，旧版 Python 实现继续保留。局域网控制不依赖 Cloud 或 Wake Gateway。

## Codex Remote

Setup 和便携包包含用户 Host 及 `CodexServer/1.18.3/LanPower.CodexServer.exe`。保存远程授权后，优先点击「连接原 Codex 窗口」。若使用「打开备用共享窗口」，官方桌面和 Host 连接同一个经认证的本机服务。桌面使用独立界面配置目录，Codex Home 与登录保持当前用户的设置。共享服务只绑定回环地址，不增加 Windows 入站防火墙规则；版本化安装目录避免升级覆盖正在运行的共享服务，安装器关闭范围仅包含 LanPower Service/Desktop/Host。未启用共享时兼容原独立会话与交还路径。

本地授权保存在 `%LOCALAPPDATA%\LanPower\codex-remote.json`，最多 32 个普通本机目录，拒绝 UNC、符号链接和目录联接。关闭授权立即断开远程访问；共享模式保留桌面任务，独立模式结束自有执行进程。共享凭据仅通过当前用户管道传递，私有目录仅允许当前用户及 SYSTEM 访问。浏览器断线不重发任务，重新连接读取活动编号、历史、队列与审批。完整步骤见 [Codex Remote](../docs/codex-remote.md)。

## 构建

安装 .NET 10 SDK 与 Inno Setup 6 后，在仓库根目录运行：

```powershell
dotnet restore windows/LanPower.sln
dotnet build windows/LanPower.sln -c Release --no-restore
dotnet test windows/LanPower.sln -c Release --no-build
dotnet run --project windows/LanPower.Desktop.Tests -c Release --no-build
./windows/installer/build-installer.ps1
```

服务与命名管道演练运行 `dotnet run --project windows/LanPower.Tests -c Release --no-build`。仅在未运行已安装 LanPower Service 的测试环境执行：此演练使用默认命名管道，并包含取消 Cloud 连接等写操作。已有实际服务的电脑使用上面的单元测试与无服务依赖的桌面检查。

桌面检查可传入截图目录，例如 `dotnet run --project windows/LanPower.Desktop.Tests -c Release --no-build -- windows/out/screenshots`；截图使用示例设备数据，覆盖六个页面的常规和最小客户区尺寸。图标源文件位于 `LanPower.Desktop/Assets/LanPower.svg`；在 Windows 运行 `scripts/generate-app-icon.ps1` 可重建 16–256 像素 ICO 与 PNG。

安装包输出为 `windows/out/LanPowerSetup-x64.exe`。构建脚本将服务和桌面端发布为自包含的 win-x64 程序，终端用户无需安装 .NET SDK 或运行命令。安装包需要管理员授权配置 LocalSystem 服务、防火墙和受保护的配对密钥。安装完成后自动打开桌面端。

Setup 在文件复制后、创建快捷方式前验证后台服务，使用原配对密钥直连本机 `/api/status`，不使用安装用户的 HTTP 代理。失败时显示阶段、异常类型与错误码，返回非零退出码，完成页显示“安装未完成”，不新建快捷方式或启动桌面端。原有快捷方式可能继续保留；这不是完整的升级回滚。安装脚本会尝试清理本轮新建但未通过检查的服务，并恢复旧版后台任务，不删除原配对数据。

安装诊断保存在 `%ProgramData%\LanPower\logs\install.log`（需管理员权限读取）；Setup 自身也会在安装进程的 `%TEMP%` 下生成 `Setup Log *.txt`。数据目录保护之前失败时，可能只有弹窗和 Setup 日志。诊断只记录阶段、类型和错误码，不记录配置内容、密钥或异常消息。完整排查方法见 [Windows 安装失败排查](../docs/windows-app.md#安装失败排查)。

运行根目录 `scripts/build-release.ps1` 可同时生成安装器、`LanPower-portable-x64.zip`、Linux ARM64 网关和校验清单，随后用 `scripts/verify-release.ps1` 检查。便携分发包同样需要管理员安装服务，并将程序复制到受保护的 Program Files 目录；运行时配置和凭据不包含在发布包中。Setup 首次安装、保留 LAN 配对的就地升级、便携包实际安装和卸载重装已通过。详见 [构建与发布](../docs/releasing.md)。

安装向导使用 Inno Setup 简体中文翻译，来源为 [Inno Setup 官方源码中的用户贡献译文](https://github.com/jrsoftware/issrc/blob/main/Files/Languages/ChineseSimplified.isl)。

## 安装与旧版兼容

- 新服务保持 TCP `48211`、`GET /api/status`、`POST /api/power`、本机 `/setup` 与 `/setup/qr.svg`，继续兼容现有微信小程序和浏览器局域网控制页；新增仅本机可访问、禁止缓存的 `/setup/qr.png`，供桌面端显示配对二维码。
- 安装程序读取并保留 `C:\ProgramData\LanPower\config.json` 内已有的 64 位十六进制配对密钥和额外旧配置字段，优先检测有线物理网卡，也支持 Wi-Fi。暂时离线时先安装服务与桌面端，联网后再配置 LAN；不会创建开放公网的入站规则。旧版开机任务只有在新服务通过健康检查后才会移除。
- Windows 防火墙只允许当前本机地址和局域网网段访问 `48211`；配对页只允许本机打开。桌面端通过 `\\.\pipe\LanPower.Service` 读取服务状态和日志，不通过 LAN API 获取配对密钥。
- 桌面端显示局域网、网卡、WOL 和 Cloud 连接状态。填写 HTTPS 地址后点击“连接 Cloud”，电脑显示短配对码；打开 Cloud 网页核对名称和短码并批准，服务自动领取凭据。短码十分钟内有效，可在桌面端停止等待。普通用户无需直接接触设备凭据。未配置 Cloud 或 Wake Gateway 是正常状态。
- 桌面状态自动刷新，底栏显示实际间隔，并读取服务保存的 Cloud 地址。唤醒网关状态来自这台电脑的 Cloud 关联，区分未配置、离线、在线但待配置电脑和远程唤醒可用。Cloud 连接中断时显示等待云端连接，不继续显示旧的可用状态；后台服务断开时同时清除旧地址。旧 Cloud 未返回网关信息时显示状态未知，直连控制仍兼容。
- 总览的“配置远程唤醒”与远程连接页的“选择唤醒网关”会打开 Cloud 并预选本机。网页选择网关后自动同步唤醒信息，并显示等待上线、配置进度与失败原因；已建立的关联无需重复选择。首次同步要求电脑与网关在线且同处一个局域网。
- 服务通过短效只读票据提供 `/api/wake-profile`，仅允许读取本机唤醒信息。票据约 90 秒过期，无法调用 LAN 电源接口；MAC、广播地址及 LAN 配对密钥不上传 Cloud。断开或更换 Cloud、所选网卡信息变化后旧票据立即失效。
- WOL 检测与 Cloud 上报共用系统网卡唤醒检测结果。系统允许网卡唤醒不保证休眠、关机或无线 WOL 一定成功，仍需检查固件、网卡和真实唤醒。
- 服务每 25 秒检测所选物理网卡。开启自动更新时，地址变化会同步更新配对页和本机防火墙范围；不会自动切换到其他网卡。网卡离线、地址不属于私有网段或配置/防火墙更新失败时，远端 LAN 请求会被拒绝，本机配对页和 Cloud 连接仍可使用。旧配置默认保留固定地址模式，可在桌面“网络设置”选择网卡并启用自动更新。
- 桌面采用设备总览、手机配对、远程连接、网络设置、日志诊断和应用设置六页导航，提供独立应用图标、状态指示、控制路径和系统托盘。再次启动会恢复已有窗口；关闭窗口默认收起到托盘，可在应用设置关闭该行为。退出界面不停止后台服务。二维码两分钟后、切页或窗口隐藏时自动收起，旧服务可使用浏览器配对页。
- “网络设置”可选择局域网网卡、切换自动更新或固定地址模式、重新检测网络、打开 Windows 网络设置；“应用设置”可手动检查正式发布版本。下载地址仅指向本项目的 GitHub 发布页；不自动下载或执行更新，也不发送设备连接信息。系统代理影响更新检查时，可关闭“更新检查使用系统代理”后重试，此选择会在当前用户下保存。
- 配对的 `device_code` 留在服务内存中；桌面端只接收本机请求标识、短配对码和批准页地址。服务拒绝 Cloud 返回的其他域名批准页。旧版 Cloud 仍可在桌面端展开“连接旧版 Cloud”，输入网页生成的长配对码。
- Cloud Agent 只发起出站 HTTPS，定期上报状态、领取限定的电源命令并回传结果。LocalSystem 服务使用直连，不依赖桌面用户的 HTTP 代理；系统透明代理仍会影响出口，需要为自己的 Cloud 域名配置服务可用的路由。连接失败日志记录异常类型、系统错误码和 HTTP 状态，不记录异常消息、响应正文、URL 或凭据。Cloud 凭据由 Windows DPAPI 加密，安装脚本将 ProgramData 数据目录限制为 SYSTEM 与管理员访问；Cloud 不接收 LAN 配对密钥。命令在执行前写入本机记录，同一命令不会重复触发电源动作。
- 刷新前先在加密文件中保存标记。刷新响应丢失或进程中断后不会再次发送旧凭据，而是提示“需要重新连接”；若仅最终写盘失败，服务在内存保留新响应并只重试本地保存。重新配对可替换中断状态，旧连接失败不会禁用新连接。
- “停止等待”会通知服务取消当前配对，防止后续批准被旧请求领取。“断开 Cloud”会清除本机 Cloud 凭据并停止取命令；有有效在线授权时还会移除 Cloud 中的原设备，否则提示用户在控制台清理。局域网配对与命令记录继续保留，已确认的物理动作无法撤回。
- 若本机 Cloud 命令记录损坏，Cloud Agent 会拒绝执行新命令；LAN 服务仍可启动并提供原有局域网功能。保留记录文件供排查，避免删除记录后立即重试尚未过期的云端命令。
- 卸载新应用会移除服务和防火墙规则，并保留 ProgramData 配对配置，供重装沿用。旧版 `source/`、`LanPower/` 与 `Install.cmd` 仍保留。

## 验证边界

2026-10-02 Codex Remote 1.11.0：71 项单元测试通过；真实官方 Runtime 验证占用错误、系统写锁释放、另一连接恢复、暂停后的自动释放和同会话继续。Setup 已就地安装，三个程序与构建哈希匹配，配置、用户授权、Cloud 地址和设备身份保留；服务与安装 Host 就绪，原生桌面未重启。完整双端活动任务控制尚未完成。

2026-10-02 Codex Remote 1.10.0：68 项 Windows 单元测试通过，包括原生已保存会话观察、长任务真实耗时、Windows 扩展路径、历史暂停与新轮状态、写锁释放和项目范围。实际只读 Runtime 确认桌面运行/结束状态和近期消息。Setup 已就地安装，三项程序与构建产物匹配；原 LAN 配置、用户授权、Cloud 地址和设备身份保留。原生桌面任务仍不可从当前网页引导或暂停，详见 [Codex Remote](../docs/codex-remote.md)。

历史 1.9.0 验证包括 63 项单元测试、42 项桌面检查、隔离 LAN/IPC dry-run 和独立项目的实际 Runtime 引导与中断；这些检查不等于原生桌面任务的双端控制验收。

2026-10-02 Codex Remote 1.8.0 历史验证：Release 构建 0 警告/错误，61 项单元测试、42 项桌面检查、隔离 LAN/IPC dry-run 以及安装配置/诊断/失败恢复/真实 Inno Setup 模拟流程通过。模拟 Runtime 覆盖中文 UTF-8、审批范围、无汇总通知的文件 Diff 和中断；当前用户真实 Codex 经 Service WSS Agent、用户 Host 与浏览器完成独立文件修改、单次审批、Diff 和刷新恢复。已重建自包含 Setup 与便携包，23 个包内文件、18 个安装组件哈希通过；本机就地升级后服务运行、安装组件匹配，原 LAN 与 Cloud 身份及用户项目授权保留。未重新执行物理电源动作。

2026-09-30 安装失败专项检查：用户反馈部分完整版 Windows 11 使用 Setup 时在末尾出现服务错误；用户在本机 Windows 沙盒安装两次均成功，故障机尚未复现，不能认定为普遍缺少运行库或已确认代理故障。本次改进安装检查、失败提示与诊断，不改动桌面端内存实现。Windows PowerShell 5.1 的直连检查、异常响应拒绝、诊断编码/隐私、服务清理及旧任务恢复回归通过；使用真实 Inno Setup 编译的隔离安装器验证成功、服务失败和无诊断文件三条路径，失败均返回非零、无新快捷方式/自动启动，完成页提示已验证。上述安装测试使用模拟服务，未停止或替换本机运行中的服务，也不替代故障机验证。

本次已重建自包含 Setup 和便携包，验证 22 个便携包文件白名单、17 个安装组件哈希、脚本 UTF-8 BOM 编码及打包内容与源码一致；此前已有的 Gateway 产物仅参与哈希与格式校验。首次安装准备、原配置数组序列化和 6 项网卡选择回归仍通过。本次产物仅供本地排查，尚未发布。

对应检查（最后一项需要 Inno Setup；脚本不管理本机真实服务）：

```powershell
./windows/installer/tests/test-install-diagnostics.ps1
./windows/installer/tests/test-install-recovery.ps1
./windows/installer/tests/test-setup-flow.ps1
```

2026-09-30 Windows 内存只读检查：已安装桌面端隐藏窗口时，三分钟私有工作集约 99.25–99.83 MiB，服务约 22.58–26.45 MiB。确认仍有托盘生命周期、页面按需创建和重复分配方面的优化空间；本轮未修改应用或运行配置，未量化优化收益。版本边界、运行时计数器与建议见 [Windows 客户端内存检查](../docs/windows-memory-review.md)。

2026-09-30 桌面界面改版：32 项无服务依赖的桌面检查通过，包括六页导航、两种尺寸的渲染与文字宽度、状态断开与恢复、二维码 PNG 加载、旧服务回退、手动与超时收起、切页取消请求。实际桌面程序读取已安装服务、导航、关闭到托盘、重复启动恢复原窗口、日志读取、偏好保存和关闭界面检查通过，后台服务保持运行。界面截图使用示例数据；这些检查不代表重新验证手机扫码或物理电源动作。

本轮从仅含桌面相关改动的源码快照完成 Release 构建（0 警告、0 错误）、49 项单元测试和上述 32 项桌面检查。独立 dry-run 服务确认 `/setup/qr.png` 返回有效 PNG 与 `no-store`，通过本机局域网地址访问被配对接口以 403 拒绝。已生成自包含 Setup 和便携分发包，核对便携包 21 个文件白名单、16 个组件哈希，并实际启动自包含桌面程序复验窗口生命周期。本轮没有运行安装升级或真实电源动作；下述安装迁移记录来自此前验收。

自动验证使用 `--dry-run` 启动新服务，检查旧版 LAN 状态与电源接口、配对页二维码、动作白名单、15 秒间隔限制和命名管道状态。Cloud 单元测试使用模拟服务验证配对批准、拒绝、过期、替换、保存失败重试、心跳、取命令、回执与重复命令记录。实机自动验收只发送状态查询；睡眠、休眠、重启、关机和 WOL 的物理结果由用户手动确认。

2026-09-30 产品功能补齐后：Release 构建、49 项单元测试、服务/命名管道演练及 6 项安装网络选择检查通过；Cloud 最新 83 项测试通过。新增测试确认连接诊断保留错误码，同时过滤 URL、Token 和 Authorization 信息。实际 WPF 布局和物理网卡只读检查通过。公开版本查询使用直连成功，系统代理路径在当前环境失败；界面提供代理选择和失败提示。

同日已按用户授权替换旧环境，在目标 Windows 完成 Setup 管理员首次安装：服务以 LocalSystem 从受保护的 Program Files 路径运行，LAN 页面返回 200，桌面命名管道可读，防火墙只允许所选局域网地址和网段。已安装服务与桌面程序的 SHA-256 与构建产物一致。安装过程中修复了两个实际问题：不存在旧服务时必须显式返回成功，单个 `allowed_networks` 必须序列化为 JSON 数组；安装后服务脚本失败时，Setup 返回非零退出码。Windows PowerShell 5.1 回归检查已加入 CI：

```powershell
./windows/installer/tests/test-prepare-install.ps1
./windows/installer/tests/test-install-config.ps1
```

随后使用实际安装器完成就地升级，原 LAN 配对密钥保持不变，已安装文件与最新构建哈希一致。真实公网短码批准和凭据兑换通过；没有网关时，网页 `status` 命令经 `windows_direct` 返回 `completed`。LocalSystem 服务重启后使用原 DPAPI 凭据自动恢复在线，真实会话的 Access/Refresh 轮换也已观察到成功。

继续完成实际安装生命周期检查：使用保留的旧 Python 安装流程启动旧服务，再运行新版 Setup；原 LAN 配对密钥保持不变，旧开机任务在新版服务健康后移除，原 Cloud 授权恢复。解压便携包并实际安装后，服务仍从 Program Files 以 LocalSystem 运行，组件哈希与发布产物一致，已配对的 LAN 状态查询和 Cloud 连接通过。

实际运行 Setup 卸载器，确认服务和安装的服务程序被移除，ProgramData 中的配置、加密凭据和命令记录哈希保持不变，日志目录保留。再次运行 Setup 后，原 LAN 配对继续可用，Cloud 自动恢复连接，安装组件哈希仍匹配。此前验收结束时环境恢复为 Setup 安装版本。

2026-09-30 曾按用户要求卸载本机旧 Windows 服务：使用已安装卸载程序完成卸载，`LanPowerService`、`LanPower LAN Only` 防火墙规则和 `C:\Program Files\LanPower` 已移除，`C:\ProgramData\LanPower` 数据目录保留。此为历史卸载记录；当前状态以以下自动配置升级验收为准。

2026-09-30 自动配置更新：55 项 Windows 单元测试、36 项桌面检查及 Release 构建通过。使用 `1.5.0` Setup 在用户现有安装目录完成就地升级，升级前备份程序与数据，LAN 配对和 Cloud 连接保留，组件哈希匹配。本机服务与 Cloud 实际运行 `1.5.0`，真实路由器运行 `2.1.0`，自动配置完成后桌面显示“远程唤醒可用”。本轮未执行真实电源动作，详见 [自动配置验收](../docs/wake-gateway.md#自动配置验收2026-09-30)。

本次首次安装由用户明确授权删除旧数据且不备份；后续旧版迁移使用仓库保留的 Python 分发程序重现实机升级。真实网卡变化和防火墙随地址变化仍待验收，真实电源动作由用户另行手动测试。

本轮 Codex Remote 系统对齐见 [1.15 系统说明](../docs/codex-system-parity.md)：完整历史分段传输、原窗口状态与模型同步、电脑端项目/聊天组织、文件图片及能力目录。小程序保持原生简化界面，已支持同一大响应协议。
