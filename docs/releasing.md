# 构建与发布

当前公开整套发布仍为 `v1.6.1`；未发布源码版本为 Windows / Cloud `1.8.0`、小程序 `2.0.6`、Wake Gateway `2.1.2`。本轮仅更新本机 Docker 和 Windows 应用，不同步远程仓库；各硬件场景的实机边界仍以验收文档为准。

2026-10-01：将此前本地累积更新整理为公开发布，更新组件版本、README、发布说明和资源清单。推送 `main` 触发 CI；推送版本标签触发验证、Release 与 GHCR 发布。

## 公开文件检查

同步源码或正式发布前运行：

```powershell
python scripts/validate-public-files.py
```

检查 Git 暂存区的私有路径、AppID、私钥、常见凭据、真实网卡地址，检查主分支提交邮箱使用 GitHub noreply 地址，以及网关配置示例和旧小程序 WOL 默认值。公开示例只使用脚本中规定的演示 MAC、地址和 Cloud URL，凭据保留 `REPLACE_` 占位符。CI 也执行该检查；本地运行配置、设备凭据、恢复码和含环境信息的原稿由 `.gitignore` 排除。此检查不能替代对源码和提交记录的个人信息审查。

MAC 检查匹配完整地址，避免把较长 SVG 坐标串中的片段误判为网卡地址。公开文件检查的 5 项回归覆盖私有路径、凭据脱敏、演示地址、SVG 坐标和暂存区内容，确保工作区覆盖文件不能隐藏已经暂存的私密内容。

## 本地生成产物

Windows 构建环境需要 .NET 10 SDK、Go 1.27.1 和 Inno Setup 6。在仓库根目录运行：

```powershell
./scripts/build-release.ps1
./scripts/verify-release.ps1
```

工具未加入 PATH 时，可传入 `-DotnetPath`、`-GoPath` 和 `-IsccPath`。产物位于 `windows/out/`：

| 文件 | 用途 |
|---|---|
| `LanPowerSetup-x64.exe` | 自包含 Windows 安装器，安装服务、桌面端和用户 Codex Host |
| `LanPower-portable-x64.zip` | 不使用 Setup.exe 的分发包，仍需管理员安装 Windows 服务 |
| `lanpower-gateway-linux-arm64` | 同时支持旧协议和二代协议的 Linux ARM64 网关 |
| `LanPower-mini-program.zip` | 从已提交公开源码生成的小程序包，不含个人 AppID 或私有配置 |
| `SHA256SUMS.txt` | 四个发布文件的 SHA-256 校验值 |

产品版本以根目录 `VERSION` 为准，必须与 Windows 程序版本、Cloud 包版本及运行时版本一致。小程序和网关保持独立组件版本，协议仍为 2（网关兼容协议 1）。构建前提交公开改动，小程序包通过 `git archive HEAD mini_program` 生成；本地忽略的预览配置不会进入包。

便携包使用固定文件白名单：服务、桌面组件、用户 Codex Host、安装脚本（含 `install-diagnostics.ps1`）、打开入口及说明，共 23 个文件。包内 `FILES.sha256` 校验 18 个安装组件；外部 `SHA256SUMS.txt` 校验整个 ZIP。包内不含 Codex CLI、Codex Home、登录文件、运行时配置、设备凭据、配对码、数据库、日志或调试符号。`AGENTS.md`、`auth.json`、`tokens.json`、`codex-remote.json` 和 `.codex/` 同时由公开文件检查排除。安装脚本使用 UTF-8 BOM，支持 Windows PowerShell 5.1。

安装便携包时，先解压再运行 `Install.cmd`，安装完成后用 `Open.cmd` 打开桌面端。安装会将程序复制到受保护的 `Program Files\LanPower`，服务不会从普通用户可修改的解压目录运行。已有 Setup 安装建议继续用同类安装器升级；配置保留在 `ProgramData\LanPower`。包内哈希不能证明下载来源，应同时核对正式发布页提供的整个文件校验值。

## 本地检查

CI 使用 Windows PowerShell 5.1 验证安装配置、服务健康检查、错误诊断和失败清理；使用真实 Inno Setup 编译模拟安装器，验证服务失败时退出码非零、完成页显示未完成且不新建快捷方式或自动启动。测试只写临时目录，不安装真实服务。具体命令见 [Windows 验证记录](../windows/README.md#验证边界)。这些回归检查不代表故障电脑已经修复。

发布校验检查四个文件的哈希、网关 ELF 架构、便携 ZIP 白名单与组件哈希、小程序包的公开清单、AppID 和版本。解压后的服务也可复用 LAN 与命名管道演练：

```powershell
Expand-Archive windows/out/LanPower-portable-x64.zip -DestinationPath "$env:TEMP/LanPower-portable-test" -Force
dotnet run --project windows/LanPower.Tests -c Release -- "$env:TEMP/LanPower-portable-test/Service/LanPower.Service.exe"
```

该演练使用独立临时配置、`--dry-run` 和按进程隔离的命名管道，不会连接已安装的生产服务、修改防火墙或执行真实电源动作。尚未完成的实机项目列于 [架构验收清单](architecture-v2.md#阶段证据与剩余项)，包括新版物理电源动作和多电脑硬件场景。

## GitHub Actions

`.github/workflows/release.yml` 复用 CI 的 Windows、Cloud、小程序和 Gateway 检查，随后生成并校验五个发布文件、演练解压后的服务，以及构建 Cloud 镜像。

- 手动运行默认只构建和保存工作流产物，不上传 Release 或 GHCR。
- 发布仅在版本标签触发，或手动选择版本标签并明确开启 `publish` 时执行。
- 发布标签必须与根目录 `VERSION`、Windows 和 Cloud 版本一致；当前源码的候选标签为 `v1.8.0`，尚未创建或推送。分支和错误版本会被拒绝。
- Windows 文件和 Cloud 镜像均构建、验证成功后，才进入上传步骤。Cloud 镜像保存为 `ghcr.io/<仓库所有者小写>/lanpower-cloud:<产品版本>` 和 `sha-<源码提交>`，不覆盖 `latest`。
- Release 只上传五个明确列出的文件；说明来自 `docs/release-notes.md`。已有相同版本 Release 时更新对应附件。

发布前应按实际验收结果更新说明，确认标签内容和公开文件。打标签和推送会触发外部发布，只在用户明确要求同步远程时执行。

## 历史验证记录

2026-10-01 发布前本地验证：Cloud 119 项、旧 LAN API 5 项、旧 Relay 3 项、Windows 55 项单元测试、36 项桌面检查、小程序两套回归与网页状态脚本通过；安装器网络选择、配置序列化、健康诊断、失败恢复和真实 Inno Setup 模拟流程通过。新增 4 项公开文件检查回归、标签正向和拒绝检查通过，工作流静态检查通过。服务 IPC 演练已隔离到测试进程，验证版本上报与 Cloud 断开操作仅作用于临时配置。完整平台构建与发布结果以该版本的 GitHub Actions 为准。

2026-09-30：三个二进制产物与校验清单本地生成成功；ZIP 白名单、组件哈希、编码与 Windows 程序版本检查通过；解压后自包含服务的 LAN/命名管道演练通过；Go Linux 静态检查和 `-version` 实际运行通过；工作流静态检查与发布标签正向/拒绝检查通过。上述记录为本地构建验证；后续主分支同步触发的 CI 结果以对应提交的 Actions 为准，正式发布工作流暂缓。

同日实际运行解压后的便携安装入口，确认 LocalSystem 服务从受保护的 Program Files 运行，安装组件与构建哈希一致，原 LAN 配对与 Cloud 连接恢复。旧 Python 到 Setup 迁移、Setup 卸载保留数据及重新安装也已通过，当前环境恢复为 Setup 安装版本；真实网络变化和电源动作仍见架构验收清单。

## 2026-10-01 公开信息清理

本地先备份完整 Git 历史、Release 元数据与全部旧附件，并核对原附件 SHA-256。随后仅对公开主分支和版本标签清理个人提交邮箱、个人网络示例、小程序 AppID 与私有原稿；当前功能源码保持完整。历史附件保留原程序二进制，替换个人示例或文档后更新校验文件。

远程历史更新使用逐个引用的旧哈希作为 `--force-with-lease` 条件，避免覆盖新出现的远程提交。已有克隆请保存工作后重新克隆。此操作不保证清除 GitHub 缓存、旧提交直链、Fork 或其他人的本地副本。日常提交已改用 GitHub noreply 地址；`.gitignore`、CI 内容检查、安装包白名单和仅从 Git 提交打包共同防止再次夹带私有配置。
