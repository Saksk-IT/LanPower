# Windows 应用（Milestone 1、3 与 4）

本目录是 .NET 10 Windows 服务、WPF 桌面端和安装包的源码。服务同时提供 LAN Direct 与可选的 Cloud Direct，旧版 Python 实现继续保留。局域网控制不依赖 Cloud 或 Wake Gateway。

## 构建

安装 .NET 10 SDK 与 Inno Setup 6 后，在仓库根目录运行：

```powershell
dotnet restore windows/LanPower.sln
dotnet build windows/LanPower.sln -c Release --no-restore
dotnet test windows/LanPower.sln -c Release --no-build
dotnet run --project windows/LanPower.Tests -c Release --no-build
./windows/installer/build-installer.ps1
```

安装包输出为 `windows/out/LanPowerSetup-x64.exe`。构建脚本将服务和桌面端发布为自包含的 win-x64 程序，终端用户无需安装 .NET SDK 或运行命令。安装包需要管理员授权配置 LocalSystem 服务、防火墙和受保护的配对密钥。安装完成后自动打开桌面端。

运行根目录 `scripts/build-release.ps1` 可同时生成安装器、`LanPower-portable-x64.zip`、Linux ARM64 网关和校验清单，随后用 `scripts/verify-release.ps1` 检查。便携分发包同样需要管理员安装服务，并将程序复制到受保护的 Program Files 目录；运行时配置和凭据不包含在发布包中。Setup 首次安装、保留 LAN 配对的就地升级、便携包实际安装和卸载重装已通过。详见 [构建与发布](../docs/releasing.md)。

安装向导使用 Inno Setup 简体中文翻译，来源为 [Inno Setup 官方源码中的用户贡献译文](https://github.com/jrsoftware/issrc/blob/main/Files/Languages/ChineseSimplified.isl)。

## 安装与旧版兼容

- 新服务保持 TCP `48211`、`GET /api/status`、`POST /api/power`、本机 `/setup` 与 `/setup/qr.svg`，继续兼容现有微信小程序和浏览器局域网控制页。
- 安装程序读取并保留 `C:\ProgramData\LanPower\config.json` 内已有的 64 位十六进制配对密钥和额外旧配置字段，优先检测有线物理网卡，也支持 Wi-Fi。暂时离线时先安装服务与桌面端，联网后再配置 LAN；不会创建开放公网的入站规则。旧版开机任务只有在新服务通过健康检查后才会移除。
- Windows 防火墙只允许当前本机地址和局域网网段访问 `48211`；配对页只允许本机打开。桌面端通过 `\\.\pipe\LanPower.Service` 读取服务状态和日志，不通过 LAN API 获取配对密钥。
- 桌面端显示局域网、网卡、WOL 和 Cloud 连接状态。填写 HTTPS 地址后点击“连接 Cloud”，电脑显示短配对码；打开 Cloud 网页核对名称和短码并批准，服务自动领取凭据。短码十分钟内有效，可在桌面端停止等待。普通用户无需直接接触设备凭据。未配置 Cloud 或 Wake Gateway 是正常状态。
- 桌面状态每 20 秒刷新，并读取服务保存的 Cloud 地址。唤醒网关状态来自这台电脑的 Cloud 关联，区分未配置、离线、在线但待配置电脑和远程唤醒可用。Cloud 连接中断时显示等待云端连接，不继续显示旧的可用状态。旧 Cloud 未返回网关信息时显示状态未知，直连控制仍兼容。
- WOL 检测与 Cloud 上报共用系统网卡唤醒检测结果。系统允许网卡唤醒不保证休眠、关机或无线 WOL 一定成功，仍需检查固件、网卡和真实唤醒。
- 服务每 25 秒检测所选物理网卡。开启自动更新时，地址变化会同步更新配对页和本机防火墙范围；不会自动切换到其他网卡。网卡离线、地址不属于私有网段或配置/防火墙更新失败时，远端 LAN 请求会被拒绝，本机配对页和 Cloud 连接仍可使用。旧配置默认保留固定地址模式，可在桌面“设置与更新”选择网卡并启用自动更新。
- 桌面“设置与更新”可选择局域网网卡、切换自动更新或固定地址模式、重新检测网络、打开 Windows 网络设置，以及手动检查正式发布版本。下载地址仅指向本项目的 GitHub 发布页；不自动下载或执行更新，也不发送设备连接信息。系统代理影响更新检查时，可关闭“更新检查使用系统代理”后重试，此选择会在当前用户下保存。
- 配对的 `device_code` 留在服务内存中；桌面端只接收本机请求标识、短配对码和批准页地址。服务拒绝 Cloud 返回的其他域名批准页。旧版 Cloud 仍可在桌面端展开“连接旧版 Cloud”，输入网页生成的长配对码。
- Cloud Agent 只发起出站 HTTPS，定期上报状态、领取限定的电源命令并回传结果。LocalSystem 服务使用直连，不依赖桌面用户的 HTTP 代理；系统透明代理仍会影响出口，需要为自己的 Cloud 域名配置服务可用的路由。连接失败日志记录异常类型、系统错误码和 HTTP 状态，不记录异常消息、响应正文、URL 或凭据。Cloud 凭据由 Windows DPAPI 加密，安装脚本将 ProgramData 数据目录限制为 SYSTEM 与管理员访问；Cloud 不接收 LAN 配对密钥。命令在执行前写入本机记录，同一命令不会重复触发电源动作。
- 刷新前先在加密文件中保存标记。刷新响应丢失或进程中断后不会再次发送旧凭据，而是提示“需要重新连接”；若仅最终写盘失败，服务在内存保留新响应并只重试本地保存。重新配对可替换中断状态，旧连接失败不会禁用新连接。
- “停止等待”会通知服务取消当前配对，防止后续批准被旧请求领取。“断开 Cloud”会清除本机 Cloud 凭据并停止取命令；有有效在线授权时还会移除 Cloud 中的原设备，否则提示用户在控制台清理。局域网配对与命令记录继续保留，已确认的物理动作无法撤回。
- 若本机 Cloud 命令记录损坏，Cloud Agent 会拒绝执行新命令；LAN 服务仍可启动并提供原有局域网功能。保留记录文件供排查，避免删除记录后立即重试尚未过期的云端命令。
- 卸载新应用会移除服务和防火墙规则，并保留 ProgramData 配对配置，供重装沿用。旧版 `source/`、`LanPower/` 与 `Install.cmd` 仍保留。

## 验证边界

自动验证使用 `--dry-run` 启动新服务，检查旧版 LAN 状态与电源接口、配对页二维码、动作白名单、15 秒间隔限制和命名管道状态。Cloud 单元测试使用模拟服务验证配对批准、拒绝、过期、替换、保存失败重试、心跳、取命令、回执与重复命令记录。实机自动验收只发送状态查询；睡眠、休眠、重启、关机和 WOL 的物理结果由用户手动确认。

2026-09-30 产品功能补齐后：Release 构建、49 项单元测试、服务/命名管道演练及 6 项安装网络选择检查通过；Cloud 最新 83 项测试通过。新增测试确认连接诊断保留错误码，同时过滤 URL、Token 和 Authorization 信息。实际 WPF 布局和物理网卡只读检查通过。公开版本查询使用直连成功，系统代理路径在当前环境失败；界面提供代理选择和失败提示。

同日已按用户授权替换旧环境，在目标 Windows 完成 Setup 管理员首次安装：服务以 LocalSystem 从受保护的 Program Files 路径运行，LAN 页面返回 200，桌面命名管道可读，防火墙只允许所选局域网地址和网段。已安装服务与桌面程序的 SHA-256 与构建产物一致。安装过程中修复了两个实际问题：不存在旧服务时必须显式返回成功，单个 `allowed_networks` 必须序列化为 JSON 数组；安装后服务脚本失败时，Setup 返回非零退出码。Windows PowerShell 5.1 回归检查已加入 CI：

```powershell
./windows/installer/tests/test-prepare-install.ps1
./windows/installer/tests/test-install-config.ps1
```

随后使用实际安装器完成就地升级，原 LAN 配对密钥保持不变，已安装文件与最新构建哈希一致。真实公网短码批准和凭据兑换通过；没有网关时，网页 `status` 命令经 `windows_direct` 返回 `completed`。LocalSystem 服务重启后使用原 DPAPI 凭据自动恢复在线，真实会话的 Access/Refresh 轮换也已观察到成功。

继续完成实际安装生命周期检查：使用保留的旧 Python 安装流程启动旧服务，再运行新版 Setup；原 LAN 配对密钥保持不变，旧开机任务在新版服务健康后移除，原 Cloud 授权恢复。解压便携包并实际安装后，服务仍从 Program Files 以 LocalSystem 运行，组件哈希与发布产物一致，已配对的 LAN 状态查询和 Cloud 连接通过。

实际运行 Setup 卸载器，确认服务和安装的服务程序被移除，ProgramData 中的配置、加密凭据和命令记录哈希保持不变，日志目录保留。再次运行 Setup 后，原 LAN 配对继续可用，Cloud 自动恢复连接，安装组件哈希仍匹配。当前环境已恢复为 Setup 安装版本。

本次首次安装由用户明确授权删除旧数据且不备份；后续旧版迁移使用仓库保留的 Python 分发程序重现实机升级。真实网卡变化和防火墙随地址变化仍待验收，真实电源动作由用户另行手动测试。
