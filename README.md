# LanPower

LanPower 用于管理 Windows 电脑的电源。在家可通过局域网控制电脑；在外可通过 Cloud 网页直接控制在线电脑。Wake Gateway 是可选组件，用于远程唤醒离线电脑。新 Windows 应用、Cloud Web 与 Cloud Direct 已在指定公网服务器和本机 Windows 部署，真实 Passkey 初始化和无网关只读状态链路已通过；新版尚未正式发布，物理电源动作仍待手动验收。

## 使用方式

| 模式 | 所需组件 | 当前状态 |
|---|---|---|
| LAN Direct | Windows + 微信小程序 | 已可用，不依赖 Cloud 或路由器程序 |
| Cloud Direct | 新 Windows 应用 + Cloud + 浏览器 | 公网只读状态已通过；在线电脑不需要 Wake Gateway |
| 小程序 v2 | 新 Windows 应用 + Cloud + 微信小程序 | 原生编译已由用户确认通过；扫码授权、设备列表及网络切换待微信真机验收 |
| Remote Wake | Windows + Cloud + Wake Gateway | v1.1.2 已验证；新版路由器注册与单电脑关联已通过，物理唤醒和多电脑仍待验收 |

普通用户可先使用下方已发布版本。开发者可按 [Windows 应用构建与安装说明](windows/README.md) 构建新服务、桌面端和安装包；新安装包尚未发布。

新版 [Cloud Web 部署说明](cloud_app/README.md) 介绍 Passkey 初始化与登录、恢复码、无网关模式、浏览器控制与旧版 Gateway 兼容。[Cloud Direct 说明](docs/cloud-direct.md) 列出配对步骤、控制路径和验收边界。

完整文档入口：[架构与实现状态](docs/architecture-v2.md)、[Windows 应用](docs/windows-app.md)、[Docker 一键 HTTPS](deploy/docker/README.md)、[认证](docs/authentication-v2.md)、[数据迁移](docs/migration-v1.md)、[安全边界](docs/security-model.md)、[故障排查](docs/troubleshooting.md)。

新版安装器、便携分发包、ARM64 网关及校验清单已在本地生成并校验。Setup 首次安装、旧 Python 版本迁移、新版就地升级、便携包实际安装及卸载重装已通过，原 LAN 配对和 Cloud 连接可保留。开发者可按 [构建与发布](docs/releasing.md) 重现；剩余验收见 [开发与验收清单](docs/implementation-checklist.md)，本轮未正式发布。

## 新架构快速开始（源码版本）

1. 按 [Windows 构建说明](windows/README.md) 生成并安装 Windows 应用，或等待新版安装包发布。安装后，局域网控制无需 Cloud。
2. 按 [Cloud 部署说明](cloud_app/README.md) 部署 HTTPS Cloud。只有 Windows 与浏览器时，无需配置网关。
3. 在 Windows 应用中输入 Cloud 地址，点击“连接 Cloud”查看设备配对码。登录 Cloud 网页的“连接 Windows 电脑”，输入短码并核对名称后允许连接。电脑在线后，可在网页中查看状态、睡眠、休眠、重启和关机；远程唤醒仍需 Wake Gateway。
4. 手机需要远程控制时，在 Cloud“已授权客户端”页面生成二维码，用新版小程序扫码。选中电脑后，可单独扫描该电脑的局域网码以启用局域网优先；详见 [小程序 v2](docs/mini-program-v2.md)。
5. 需要远程开机时，按 [Wake Gateway v2](docs/wake-gateway.md) 在路由器上注册网关、配置电脑并在 Cloud 关联。一个网关支持多台电脑，Windows 在线时仍优先直连。

## 最新版本

当前版本：**v1.1.2 Remote Gateway Preview**。从 [v1.1.2 发布页下载完整包](https://github.com/Saksk-IT/LanPower/releases/tag/v1.1.2)。发布包包含 Windows 程序、微信小程序、Gateway 的 Linux ARM64 二进制及源码、Cloud 源码和安装说明。远程功能需要用户自己的 HTTPS 域名、云服务器和私有凭据；仓库不包含这些信息。一套实际部署已在 iPhone 5G 下完成远程状态、睡眠和唤醒实测。

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
