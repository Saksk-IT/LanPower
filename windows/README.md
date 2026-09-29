# Windows 应用（Milestone 1 与 3）

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

安装向导使用 Inno Setup 简体中文翻译，来源为 [Inno Setup 官方源码中的用户贡献译文](https://github.com/jrsoftware/issrc/blob/main/Files/Languages/ChineseSimplified.isl)。

## 安装与旧版兼容

- 新服务保持 TCP `48211`、`GET /api/status`、`POST /api/power`、本机 `/setup` 与 `/setup/qr.svg`，继续兼容现有微信小程序和浏览器局域网控制页。
- 安装程序读取并保留 `C:\ProgramData\LanPower\config.json` 内已有的 64 位十六进制配对密钥，重新检测有线网卡地址和网段。旧版开机任务只有在新服务通过健康检查后才会移除。
- Windows 防火墙只允许当前本机地址和局域网网段访问 `48211`；配对页只允许本机打开。桌面端通过 `\\.\pipe\LanPower.Service` 读取服务状态和日志，不通过 LAN API 获取配对密钥。
- 桌面端显示局域网、网卡、WOL 和 Cloud 连接状态。在 Cloud 网页生成一次性配对码后，通过桌面端填写 HTTPS 地址与配对码；普通用户无需直接接触设备凭据。未配置 Cloud 或 Wake Gateway 是正常状态。
- Cloud Agent 只发起出站 HTTPS，定期上报状态、领取限定的电源命令并回传结果。Cloud 凭据由 Windows DPAPI 加密，安装脚本将 ProgramData 数据目录限制为 SYSTEM 与管理员访问；Cloud 不接收 LAN 配对密钥。命令在执行前写入本机记录，同一命令不会重复触发电源动作。
- 若本机 Cloud 命令记录损坏，Cloud Agent 会拒绝执行新命令；LAN 服务仍可启动并提供原有局域网功能。保留记录文件供排查，避免删除记录后立即重试尚未过期的云端命令。
- 卸载新应用会移除服务和防火墙规则，并保留 ProgramData 配对配置，供重装沿用。旧版 `source/`、`LanPower/` 与 `Install.cmd` 仍保留。

## 验证边界

自动验证使用 `--dry-run` 启动新服务，检查旧版 LAN 状态与电源接口、配对页二维码、动作白名单、15 秒间隔限制和命名管道状态。Cloud 单元测试使用模拟服务验证配对、心跳、取命令、回执与重复命令记录。真实睡眠、休眠、重启、关机、WOL、安装迁移和公网连接需要在可恢复的 Windows 实机上逐项确认；自动测试不会改变电脑电源状态。
