# 构建与发布

新架构仍处于源码验证阶段。构建发布产物不代表正式发布，也不替代公网、Windows 管理员安装、微信和网关实机验收。

2026-09-30 自动配置更新：`1.5.0` 已完成本地构建与现有环境升级，本次源码仅提交本地，尚未推送或正式发布。推送 `main` 触发 CI 检查，不触发版本标签发布流程。

## 公开文件检查

同步源码或正式发布前运行：

```powershell
python scripts/validate-public-files.py
```

检查 Git 跟踪的私有文件路径、暂存的网关配置示例和旧小程序 WOL 默认值。公开示例只使用脚本中规定的演示 MAC、地址和 Cloud URL，凭据保留 `REPLACE_` 占位符。CI 也执行该检查；本地运行配置、设备凭据、恢复码和含环境信息的原稿由 `.gitignore` 排除。此检查不能替代对源码和提交记录的个人信息审查。

## 本地生成产物

Windows 构建环境需要 .NET 10 SDK、Go 1.27.1 和 Inno Setup 6。在仓库根目录运行：

```powershell
./scripts/build-release.ps1
./scripts/verify-release.ps1
```

工具未加入 PATH 时，可传入 `-DotnetPath`、`-GoPath` 和 `-IsccPath`。产物位于 `windows/out/`：

| 文件 | 用途 |
|---|---|
| `LanPowerSetup-x64.exe` | 自包含 Windows 安装器，安装服务和桌面端 |
| `LanPower-portable-x64.zip` | 不使用 Setup.exe 的分发包，仍需管理员安装 Windows 服务 |
| `lanpower-gateway-linux-arm64` | 同时支持旧协议和二代协议的 Linux ARM64 网关 |
| `SHA256SUMS.txt` | 三个发布文件的 SHA-256 校验值 |

Windows 应用与 Cloud 的当前产品版本为 `1.5.0`；网关版本为 `2.1.0`，小程序版本为 `2.0.1`。本次新增网关自动配置，更新产品与网关的次版本号，小程序同步更新帮助说明。网关同时支持协议 1 和 2，小程序新入口使用协议 2 并保留旧入口。产品标签不是所有组件的协议版本。

便携包使用固定文件白名单：服务和桌面组件、安装脚本（含 `install-diagnostics.ps1`）、打开入口及说明，共 22 个文件。包内 `FILES.sha256` 校验 17 个安装组件；外部 `SHA256SUMS.txt` 校验整个 ZIP。包内不含运行时配置、设备凭据、配对码、数据库、日志或调试符号。安装脚本使用 UTF-8 BOM，支持 Windows PowerShell 5.1。

安装便携包时，先解压再运行 `Install.cmd`，安装完成后用 `Open.cmd` 打开桌面端。安装会将程序复制到受保护的 `Program Files\LanPower`，服务不会从普通用户可修改的解压目录运行。已有 Setup 安装建议继续用同类安装器升级；配置保留在 `ProgramData\LanPower`。包内哈希不能证明下载来源，应同时核对正式发布页提供的整个文件校验值。

## 本地检查

CI 使用 Windows PowerShell 5.1 验证安装配置、服务健康检查、错误诊断和失败清理；使用真实 Inno Setup 编译模拟安装器，验证服务失败时退出码非零、完成页显示未完成且不新建快捷方式或自动启动。测试只写临时目录，不安装真实服务。具体命令见 [Windows 验证记录](../windows/README.md#验证边界)。这些回归检查不代表故障电脑已经修复。

发布校验检查三个文件的哈希、网关 ELF 架构、ZIP 完整白名单以及所有安装组件的哈希。解压后的服务也可复用 LAN 与命名管道演练：

```powershell
Expand-Archive windows/out/LanPower-portable-x64.zip -DestinationPath "$env:TEMP/LanPower-portable-test" -Force
dotnet run --project windows/LanPower.Tests -c Release -- "$env:TEMP/LanPower-portable-test/Service/LanPower.Service.exe"
```

该演练使用独立临时配置和 `--dry-run`，不会安装服务、修改防火墙或执行真实电源动作。正式发布仍需完成 [架构验收清单](architecture-v2.md#阶段证据与剩余项)，尤其是关闭网关后的公网 Windows 控制。

## GitHub Actions

`.github/workflows/release.yml` 复用 CI 的 Windows、Cloud、小程序和 Gateway 检查，随后生成并校验四个发布文件、演练解压后的服务，以及构建 Cloud 镜像。

- 手动运行默认只构建和保存工作流产物，不上传 Release 或 GHCR。
- 发布仅在版本标签触发，或手动选择版本标签并明确开启 `publish` 时执行。
- 发布标签必须与 `windows/Directory.Build.props` 一致，当前为 `v1.5.0`；分支和错误版本会被拒绝。
- Windows 文件和 Cloud 镜像均构建、验证成功后，才进入上传步骤。Cloud 镜像保存为 `ghcr.io/<仓库所有者小写>/lanpower-cloud:<产品版本>` 和 `sha-<源码提交>`，不覆盖 `latest`。
- Release 只上传四个明确列出的文件；说明来自 `docs/release-notes.md`。已有相同版本 Release 时更新对应附件。

发布前应按实际验收结果更新说明草稿，确认标签内容和公开文件。打标签和推送会触发外部发布，只在用户明确要求同步远程时执行。

## 当前验证记录

2026-09-30：三个二进制产物与校验清单本地生成成功；ZIP 白名单、组件哈希、编码与 Windows 程序版本检查通过；解压后自包含服务的 LAN/命名管道演练通过；Go Linux 静态检查和 `-version` 实际运行通过；工作流静态检查与发布标签正向/拒绝检查通过。上述记录为本地构建验证；后续主分支同步触发的 CI 结果以对应提交的 Actions 为准，正式发布工作流暂缓。

同日实际运行解压后的便携安装入口，确认 LocalSystem 服务从受保护的 Program Files 运行，安装组件与构建哈希一致，原 LAN 配对与 Cloud 连接恢复。旧 Python 到 Setup 迁移、Setup 卸载保留数据及重新安装也已通过，当前环境恢复为 Setup 安装版本；真实网络变化和电源动作仍见架构验收清单。
