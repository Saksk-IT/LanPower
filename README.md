# LanPower：iPhone 与 Windows 局域网电源控制

这套方案使用我们自己的 **微信小程序**完成开机、睡眠、休眠、重启和关机。电脑端运行在 Windows 11 上；Safari 网页可以作为电脑在线时的备用控制页。无需 WakeCast、购买新硬件或把端口开放到公网。

## 安装

1. 在电脑上克隆仓库或解压发布包，双击 `Install.cmd`。首次运行会请求 Windows 管理员授权，以便设置开机启动任务和只允许当前家用网段访问的防火墙规则。
2. 用微信开发者工具导入发布包中的 `mini_program/`，使用自己的小程序 AppID 或测试号 AppID 在 iPhone 微信里预览。详细步骤见 `mini_program/README.md`。
3. 安装完成后，电脑会打开 `http://127.0.0.1:48211/setup`。让 iPhone 连接家里的主 Wi-Fi，与电脑处于同一局域网，在小程序里点“扫描配对二维码”扫描电脑屏幕。以后可双击 `Open-Pairing.cmd` 重新打开配对页面。
4. 小程序中的“开机”按钮负责网络唤醒；其他四个按钮在电脑在线时可用。

这台电脑目前的局域网地址是 `192.168.1.100`。如果以后路由器分配了新地址，重新运行 `Install.cmd` 更新地址和防火墙规则，再用 iPhone 扫一次码。原有配对密钥会保留。

## 网页备用控制页

- `http://192.168.1.100:48211/`：电脑在线时显示状态，并可睡眠、休眠、重启、关机。
- 电脑离线时，网页服务器也会离线；请用小程序发送 WOL 唤醒包。
- 扫码链接含有随机配对密钥，只在电脑本机的 `/setup` 页面显示；手机浏览器收到后保存在此网站的本地存储中。

## Windows 端

- 启动任务：`LanPower LAN Control`，以 SYSTEM 账户在开机时运行。
- 防火墙规则：`LanPower LAN Only`，仅放行安装时检测到的家用网段到 TCP `48211`。
- 配置与日志：`C:\ProgramData\LanPower\`。密钥文件仅 SYSTEM 和管理员可直接读取；配对页面只能在这台电脑上打开。
- 安装脚本保留已有配对密钥；`Uninstall-LanPower.ps1` 删除任务、规则与配置。

## 已验证

2026 年 9 月 28 日，iPhone 微信预览版已实测配对显示在线、睡眠后唤醒并恢复在线、关机后重新开机。电脑端接口及打包程序通过本地测试。当前版本只支持同一局域网；5G/外网控制尚未加入。

## 源码与构建

电脑端源代码、静态页面、测试和 PyInstaller 配置在 `source/`；小程序源代码在 `mini_program/`。仓库内的 `LanPower/` 是可直接安装的 Windows 程序。电脑端使用 Python 标准库处理 HTTP 和电源指令，二维码使用 `qrcode` 生成。

在 Windows 上安装 Python 3.12 后，可从仓库根目录运行：

```powershell
cd source
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-build.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe -m PyInstaller --noconfirm LanPower.spec
```

构建结果在 `source/dist/LanPower/`。将该目录内容复制到仓库根目录的 `LanPower/`，再运行 `Install.cmd` 更新电脑端。小程序测试从仓库根目录运行 `node tests/test_mini_program.js`。`source/server.py` 的 `--dry-run` 模式会接收电源指令，但不改变电脑电源状态。
