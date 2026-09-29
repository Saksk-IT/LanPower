# LanPower：iPhone 与 Windows 电源控制

这套方案使用 **微信小程序**完成开机、睡眠、休眠、重启和关机。电脑端运行在 Windows 11 上；Safari 网页可以作为电脑在线时的备用控制页。v1.1.0 新增 AX3000T Router Gateway 和 Remote Cloud 预览实现：家中优先使用原有局域网链路，离家后经 HTTPS Cloud 中继到常在线路由器，无需开放 Windows 或路由器的公网控制端口。

## 最新版本

当前版本：**v1.1.0 Remote Gateway Preview**。从 [GitHub Releases 下载完整包](https://github.com/Saksk-IT/LanPower/releases/latest)。发布包包含 Windows 程序、微信小程序、Gateway 的 Linux ARM64 二进制及源码、Cloud 源码和安装说明。远程功能需要用户自己的 HTTPS 域名、云服务器和私有凭据；仓库不包含这些信息，也尚未在实际 5G 环境完成端到端实测。

## 安装

1. 在电脑上克隆仓库或解压发布包，双击 `Install.cmd`。首次运行会请求 Windows 管理员授权，以便设置开机启动任务和只允许当前家用网段访问的防火墙规则。
2. 用微信开发者工具导入发布包中的 `mini_program/`，使用自己的小程序 AppID 或测试号 AppID 在 iPhone 微信里预览。详细步骤见 `mini_program/README.md`。
3. 安装完成后，电脑会打开 `http://127.0.0.1:48211/setup`。让 iPhone 连接家里的主 Wi-Fi，与电脑处于同一局域网，在小程序里点“扫描配对二维码”扫描电脑屏幕。以后可双击 `Open-Pairing.cmd` 重新打开配对页面。
4. 小程序中的“开机”按钮负责网络唤醒；其他四个按钮在电脑在线时可用。

电脑的局域网地址由安装时检测，并显示在配对页。如果路由器分配了新地址，重新运行 `Install.cmd` 更新地址和防火墙规则，再用 iPhone 扫一次码。原有配对密钥会保留。远程 Gateway 部署前，建议在路由器上为 PC 做 DHCP 静态绑定。

## 网页备用控制页

- `http://<电脑当前局域网地址>:48211/`：电脑在线时显示状态，并可睡眠、休眠、重启、关机。
- 电脑离线时，网页服务器也会离线；请用小程序发送 WOL 唤醒包。
- 扫码链接含有随机配对密钥，只在电脑本机的 `/setup` 页面显示；手机浏览器收到后保存在此网站的本地存储中。

## Windows 端

- 启动任务：`LanPower LAN Control`，以 SYSTEM 账户在开机时运行。
- 防火墙规则：`LanPower LAN Only`，仅放行安装时检测到的家用网段到 TCP `48211`。
- 配置与日志：`C:\ProgramData\LanPower\`。密钥文件仅 SYSTEM 和管理员可直接读取；配对页面只能在这台电脑上打开。
- 安装脚本保留已有配对密钥；`Uninstall-LanPower.ps1` 删除任务、规则与配置。

## 已验证

2026 年 9 月 28 日，iPhone 微信预览版已实测配对显示在线、睡眠后唤醒并恢复在线、关机后重新开机。2026 年 9 月 29 日，AX3000T / RD03 上的 WOL、Windows API 调用、公网 HTTPS 和自启动已有实机验证，详见 [5G/外网控制说明](docs/remote-5g.md)。本版的软件远程链路通过本地自动化验证；部署到实际 Cloud 和手机 5G 后仍需真机验证。

## 手机使用 5G 时

部署 [Remote Cloud](cloud_remote/README.md) 和 [AX3000T Gateway](router_gateway/README.md)，在小程序中扫描远程配对码。小程序先检查局域网接口；不可达时自动查询 Cloud 的网关和电脑状态，并在远程模式下将六种枚举动作交给 Gateway。电脑关机时由路由器在 LAN 发 WOL；电脑在线时由路由器访问 Windows 本地 API。完整设计和当前验证边界见 [5G/外网控制说明](docs/remote-5g.md)。

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

构建结果在 `source/dist/LanPower/`。将该目录内容复制到仓库根目录的 `LanPower/`，再运行 `Install.cmd` 更新电脑端。小程序测试从仓库根目录运行 `node tests/test_mini_program.js`；Cloud 测试运行 `python -m unittest discover -s cloud_remote/tests -v`。`source/server.py` 的 `--dry-run` 模式会接收电源指令，但不改变电脑电源状态。
