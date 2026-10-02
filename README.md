# LanPower

微信小程序开发版与正式版独立保存授权和连接配置；开发版可在「连接 → 开发版 Cloud 地址」修改本机测试地址。使用步骤见 [开发版与正式版](docs/mini-program-environments.md)。

当前源码版本：**v1.12.0**，微信小程序 **2.1.1** 新增原生 Codex Remote 页面：白色会话列表、深色模式、消息详情、底部输入栏和单次审批弹层。支持选择电脑与项目、查看会话、实时输出、补充要求、暂停和文件 Diff。公开发布版本仍为 **[v1.6.1](https://github.com/Saksk-IT/LanPower/releases/tag/v1.6.1)**；第一版界面与导入方法见 [小程序使用说明](docs/codex-remote-mini-program.md)。

Windows 主动通过 WSS 出站连接；Codex 在已登录 Windows 的用户会话中运行，Cloud 不保存任务、代码、Diff 或 OpenAI 凭据。首次在「远程连接」开启授权并保存，默认自动识别本机 Codex 项目；可关闭自动识别，改用手动目录。桌面占用的已有会话支持同步查看，需由桌面释放后才能在 Remote 继续；Remote 自己的任务支持引导和暂停。本轮已更新本机 Docker 和 Windows，保留配置与设备身份；未改动远程服务器、推送或发布 Release。[使用与验收说明](docs/codex-remote.md) · [Relay 协议](docs/codex-remote-protocol.md) · [MVP 进度](docs/codex-remote-mvp-plan.md)。

| 组件 | 当前源码版本 |
|---|---|
| Windows 应用 / 安装器 | `1.12.0` |
| Cloud 控制台 | `1.12.0` |
| 微信小程序 | `2.1.1` |
| Wake Gateway | `2.1.2` |

2026-10-03 本轮小程序第一版：原生 Codex 页面与独立手机开发权限完成，已有手机可直接修改权限，无需重新扫码。Cloud 193 项、Windows 71 项、小程序交互及微信编译检查通过；320/390/430px 的浅色、深色、审批和键盘布局通过。正常 HTTPS 的实际手机 Bearer WSS 入口、修改权限和撤销已验证；安装 Host 就绪，另一控制页面仍在使用，未抢占它执行真实任务。本机 Docker 和 Windows 已更新，原配置、配对与身份保留；真实微信、5G 和远程服务器部署待后续验收。

2026-10-02 上轮 Codex Remote 1.11：修复网页接续后桌面提示“已在另一个应用中打开”的反向占用。每条远程会话使用独立进程，任务完成或暂停后约 2–4 秒自动释放；菜单可主动“交还桌面”。释放会检查活动任务、审批与后台命令，不结束其他会话。官方 Runtime 实测确认原来的占用错误可复现、释放后另一连接可恢复同一会话、暂停后自动释放及再次继续。原生桌面正在运行的任务仍只能同步查看；完整共享控制尚未验收。 Windows 71 项、Cloud 187 项测试及浏览器 1440/390/320px 检查通过。本机 Windows 和 Docker 已更新至 1.11.0，原配置、授权与身份保留。

2026-10-02 上轮 Codex Remote 1.10：Windows 68 项单元测试、Cloud 186 项测试和浏览器 1440/390/320px 检查通过。实际 Runtime 只读请求确认当前桌面会话在运行并读到真实开始时间、近期消息；已结束的桌面会话正确区分。浏览器控制流程使用模拟响应；当前真实控制页面已被使用，本轮未抢占另一个页面完成双端控制验收。本机 Windows 和 Docker 已部署 `1.10.0`，原配置、用户授权、Cloud 地址和设备身份保留，凭据正常续期轮换。原生桌面正在执行的任务仍不能从此网页引导或暂停，手机 5G 待人工验收。

2026-10-02 上轮 Codex Remote 1.8：Cloud 184 项、Windows 61 项单元测试通过。真实登录的本机 Codex 经 WSS Agent、用户 Host 与浏览器完成单次审批、实际文件修改、Diff 和刷新恢复。

2026-10-02 上轮界面更新与正式部署：Cloud 164 项测试及浏览器 1440/390/320px 检查通过；本机 Docker、Windows 和正式 Cloud 已更新至 `1.7.2`，保留现有数据与配置。远程桌面验证覆盖文件下载、IPv4/IPv6、最新地址与错误提示；实际远程桌面登录和物理电源动作待手动验收。

2026-10-02 上轮网关修复：Cloud 增加网关可重试续期接口，正常在线时延长长期授权有效期；Gateway 兼容旧 Cloud，并在新接口可用后自动切换。续期、旧版兼容、并发检查和 Linux ARM64 构建通过。本机 Docker、Windows 和本地路由器已更新；网关在正式 Cloud `1.7.2` 上恢复连续心跳，设备身份和配置保留。续期响应丢失或重启后的完整自动恢复仍待后续网关版本验证。

## v1.7 功能概要

- SQLite 自动启用 WAL、外键和等待超时，改善并发读写。
- 活动记录支持中文事件筛选、每页 50 条及设备名称、绝对和相对时间。
- 控制台通过 SSE 实时更新设备状态，断线后自动重连。
- 按北京时间为电脑设置每日或每周电源计划，支持暂停和删除。
- 唤醒后最多等待两分钟，显示成功或未响应提示。
- 逐台电脑直接展示五个电源按钮，按在线和唤醒状态启用，重要操作先确认。
- 手机二维码可分别授权状态、睡眠、休眠、重启、关机和唤醒。
- Windows 托盘使用绿、黄、灰三色指示云端连接和本机服务状态。
- 在线电脑可下载远程桌面连接文件、复制 IP；访问电脑仍需可达的局域网或 VPN。
- 配置微信订阅消息后，可按离线阈值向多个接收人发送通知。
- 控制台适配 375–480px 手机屏幕，提供折叠菜单和触控按钮。

正式 Cloud 当前运行 `1.7.2`，公开下载入口仍为 `1.6.1`；本机 Docker 使用 `1.12.0-dev.1`，部署记录见 [本机开发指南](docs/local-development.md)。手机长期授权按 [小程序升级说明](docs/mini-program-v2.md#长期授权升级) 使用；导入新包后需重新预览或上传 `2.1.1`，已撤销或已丢失的旧授权需重新扫码。新的 Codex 手机入口需要 Cloud `1.12.0`，正式服务器本轮尚未升级。

LanPower 用于管理 Windows 电脑的电源和远程开发。在家可通过局域网控制电脑；在外可通过 Cloud 网页控制在线电脑，并连接本机 Codex Runtime。Wake Gateway 是可选组件，用于远程唤醒离线电脑。各版本的部署和实机验收结果分别记录；新版 Codex Remote 的手机 5G 公网链路仍需人工验收。

2026-10-01 发布整理：同步主分支与完整发布资源，清理公开历史中的个人邮箱、网络示例与小程序 AppID，增加发布检查。历史提交哈希已更新；已有克隆请先保存本地工作，再从主分支重新克隆。详细验证记录与剩余项见 [开发与验收清单](docs/implementation-checklist.md)。

## 使用方式

| 模式 | 所需组件 | 当前状态 |
|---|---|---|
| LAN Direct | Windows + 微信小程序 | 已可用，不依赖 Cloud 或路由器程序 |
| Cloud Direct | 新 Windows 应用 + Cloud + 浏览器 | 公网只读状态已通过；在线电脑不需要 Wake Gateway |
| 小程序 v2 | 新 Windows 应用 + Cloud + 微信小程序 | 原生编译已由用户确认通过；扫码授权、设备列表及网络切换待微信真机验收 |
| Remote Wake | Windows + Cloud + Wake Gateway | v1.1.2 已验证；新版路由器注册与单电脑关联已通过，物理唤醒和多电脑仍待验收 |
| Codex Remote | Windows 1.12 + Cloud 1.12 + 小程序 2.1 / 浏览器 PWA + 本机 Codex | 项目/会话、实时输出、引导、暂停和单次审批；桌面占用会话只读同步，微信真机与 5G 待验收 |

普通用户可从下方发布页下载安装器；开发者可按 [Windows 应用构建与安装说明](windows/README.md) 构建服务、桌面端和安装包。

新版 [Cloud Web 部署说明](cloud_app/README.md) 介绍 Passkey 初始化与登录、恢复码、无网关模式、浏览器控制与旧版 Gateway 兼容。[Cloud Direct 说明](docs/cloud-direct.md) 列出配对步骤、控制路径和验收边界。

完整文档入口：[架构与实现状态](docs/architecture-v2.md)、[Windows 应用](docs/windows-app.md)、[Docker 一键 HTTPS](deploy/docker/README.md)、[认证](docs/authentication-v2.md)、[数据迁移](docs/migration-v1.md)、[安全边界](docs/security-model.md)、[故障排查](docs/troubleshooting.md)。

## SVG 动画演示

仓库还提供一个独立的纯 HTML + SVG 演示页：[鹈鹕骑自行车 2D 动画](docs/pelican-bicycle.html)。页面版本为 `1.0.0`，可直接在浏览器打开，包含暂停和重新开始控制，不依赖外部图片或脚本。

发布资源包含安装器、便携分发包、ARM64 网关、小程序源码包及校验清单，Cloud 镜像发布至 GHCR。此前已验证 Setup 首次安装、旧 Python 迁移、就地升级、便携安装及卸载重装，可保留原 LAN 配对和 Cloud 连接。构建方法见 [构建与发布](docs/releasing.md)。

## 快速开始

开发测试可直接在本机运行 `./deploy/docker/start-dev.ps1`，然后访问 **https://localhost:8443**。独立 Docker 环境支持源码自动重载、可信本地 HTTPS 和持久化测试数据；首次配置 Windows 后台服务的证书信任时需要管理员确认。账号与操作说明见 [本机开发指南](docs/local-development.md)。当前本地部署配置版本为 `1.12.0-dev.1`。

1. 从 [发布页](https://github.com/Saksk-IT/LanPower/releases/tag/v1.6.1) 下载并运行 `LanPowerSetup-x64.exe`。安装后，局域网控制无需 Cloud。
2. 按 [Cloud 部署说明](cloud_app/README.md) 部署 HTTPS Cloud。只有 Windows 与浏览器时，无需配置网关。
3. 在 Windows 应用中输入 Cloud 地址，点击“连接 Cloud”查看设备配对码。登录 Cloud 网页的“连接电脑”，输入短码并核对名称后允许连接。电脑在线后，可在网页中查看状态、睡眠、休眠、重启和关机；远程唤醒仍需 Wake Gateway。
4. 手机需要远程控制时，在 Cloud“手机授权”页面生成二维码，用新版小程序扫码。选中电脑后，可单独扫描该电脑的局域网码以启用局域网优先；详见 [小程序 v2](docs/mini-program-v2.md)。
5. 需要远程开机时，按 [Wake Gateway v2](docs/wake-gateway.md) 在路由器上注册网关。在 Windows 点击“配置远程唤醒”，网页选择网关后自动保存电脑的唤醒信息，无需手填 MAC、广播地址或重启网关。首次配置时电脑和网关需在线并处于同一局域网；一个网关支持多台电脑。
6. 使用 Codex Remote 时，Windows 和 Cloud 均建议更新至 `1.12.0`。在当前 Windows 用户下安装并登录 Codex，在 LanPower 中启用远程开发和自动发现项目。手机在 Cloud「手机授权」开启 Codex 权限后，可从小程序底部「Codex」进入；浏览器仍可从 Cloud「Codex Remote」进入。额外目录可手动授权；桌面占用中的会话仅同步查看。公开 `1.6.1` 安装器尚不含此功能。

## 最新版本

从 **[v1.6.1 发布页](https://github.com/Saksk-IT/LanPower/releases/tag/v1.6.1)** 下载：

| 资源 | 用途 |
|---|---|
| `LanPowerSetup-x64.exe` | Windows 安装器 |
| `LanPower-portable-x64.zip` | 便携分发包，仍需管理员安装服务 |
| `lanpower-gateway-linux-arm64` | Linux ARM64 Wake Gateway |
| `LanPower-mini-program.zip` | 微信开发者工具可导入的公开小程序源码 |
| `SHA256SUMS.txt` | 以上四个文件的 SHA-256 校验值 |

Cloud 镜像：`ghcr.io/saksk-it/lanpower-cloud:1.6.1`，同时提供 `sha-<源码提交>` 标签。完整源码可使用该标签的 GitHub Source code 下载。小程序包使用 `touristappid`；发布到自己的微信账号时需自行配置 AppID。远程功能需要自己的 HTTPS 域名、Cloud 和私有凭据。

下方为历史 v1.1.2 的安装与验证说明，适用于 [v1.1.2 发布包](https://github.com/Saksk-IT/LanPower/releases/tag/v1.1.2)。新版优先使用上述安装器和文档。

## 已发布 v1.1.2 的安装

1. 在电脑上克隆仓库或解压发布包，双击 `Install.cmd`。首次运行会请求 Windows 管理员授权，以便设置开机启动任务和只允许当前家用网段访问的防火墙规则。
2. 用微信开发者工具导入发布包中的 `mini_program/`，使用自己的小程序 AppID 或测试号 AppID 在 iPhone 微信里预览。详细步骤见 `mini_program/README.md`。
3. 安装完成后，电脑会打开 `http://127.0.0.1:48211/setup`。让 iPhone 连接家里的主 Wi-Fi，与电脑处于同一局域网，在小程序里点“扫描配对二维码”扫描电脑屏幕。以后可双击 `Open-Pairing.cmd` 重新打开配对页面。
4. 小程序中的“开机”按钮负责网络唤醒；其他四个按钮在电脑在线时可用。

电脑的局域网地址由安装时检测，并显示在配对页。如果路由器分配了新地址，重新运行 `Install.cmd` 更新地址和防火墙规则，再用 iPhone 扫一次码。原有配对密钥会保留。远程 Gateway 部署前，建议在路由器上为 PC 做 DHCP 静态绑定。

## 网页备用控制页

- `http://<电脑当前局域网地址>:48211/`：电脑在线时显示状态，并可睡眠、休眠、重启、关机。
- 电脑离线时，网页服务器也会离线；请用小程序发送 WOL 唤醒包。
- 扫码链接含有随机配对密钥，只在电脑本机的 `/setup` 页面显示；手机浏览器收到后保存在此网站的本地存储中。

## 已发布 v1.1.2 的 Windows 端

- 启动任务：`LanPower LAN Control`，以 SYSTEM 账户在开机时运行。
- 防火墙规则：`LanPower LAN Only`，仅放行安装时检测到的家用网段到 TCP `48211`。
- 配置与日志：`C:\ProgramData\LanPower\`。密钥文件仅 SYSTEM 和管理员可直接读取；配对页面只能在这台电脑上打开。
- 安装脚本保留已有配对密钥；`Uninstall-LanPower.ps1` 删除任务、规则与配置。

## 已验证

2026 年 9 月 28 日，iPhone 微信预览版已实测配对显示在线、睡眠后唤醒并恢复在线、关机后重新开机。2026 年 9 月 29 日，AX3000T / RD03 上的 WOL、Windows API 调用、公网 HTTPS 和自启动已有实机验证；Cloudflare 代理入口、Cloud、Gateway 与 Windows 的在线状态及远程只读状态命令也已在实际部署中验证。iPhone 关闭 Wi-Fi 后，小程序显示“在线 · 远程”；用户通过 5G 发出睡眠和唤醒操作，电脑恢复在线，随后远程只读状态命令再次返回在线。其他远程电源动作尚未逐项真机验证，详见 [5G/外网控制说明](docs/remote-5g.md)。

## 已发布 v1.1.2 的手机远程模式

部署 [Remote Cloud](cloud_remote/README.md) 和 [AX3000T Gateway](router_gateway/README.md)，在小程序中扫描远程配对码。小程序先检查局域网接口；不可达时自动查询 Cloud 的网关和电脑状态，并在远程模式下将六种枚举动作交给 Gateway。Cloud 不可用时，只要本地配对仍在，“开机”仍可发送局域网 WOL；状态查询失败不会锁住唤醒按钮。电脑关机时由路由器在 LAN 发 WOL；电脑在线时由路由器访问 Windows 本地 API。完整设计和当前验证边界见 [5G/外网控制说明](docs/remote-5g.md)。

已有路由器配置、正在连接四端时，按 [Windows、路由器、Cloud 与手机联调清单](docs/cloud-phone-connection.md) 逐项核对凭据、HTTPS 和真机 5G 状态。不要重新生成配套凭据后只更新单独一端。

## 源码与构建

电脑端源代码、静态页面、测试和 PyInstaller 配置在 `source/`；小程序源代码在 `mini_program/`。Gateway Go 源码在 `router_gateway/`，Cloud Python 源码在 `cloud_remote/`。仓库内的 `LanPower/` 是可直接安装的 Windows 程序。电脑端使用 Python 标准库处理 HTTP 和电源指令，二维码使用 `qrcode` 生成。

在 Windows 上安装 Python 3.12 后，可从仓库根目录运行：

```powershell
cd source
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-build.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe -m PyInstaller --noconfirm LanPower.spec
```

构建结果在 `source/dist/LanPower/`。将该目录内容复制到仓库根目录的 `LanPower/`，再运行 `Install.cmd` 更新电脑端。小程序测试从仓库根目录运行 `node tests/test_mini_program.js`；Cloud 测试运行 `python -m unittest discover -s cloud_remote/tests -v`；路由器安装模拟测试在 Linux 运行 `python -m unittest discover -s router_gateway/tests -v`。GitHub Actions CI 还执行 Gateway Go 测试、静态检查、Shell 语法检查和 Linux ARM64 静态构建。`source/server.py` 的 `--dry-run` 模式会接收电源指令，但不改变电脑电源状态。
