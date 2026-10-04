LanPower Windows 便携分发包

1. 解压到本机目录，双击 Install.cmd，并允许 Windows 管理员授权。
2. 安装完成后，双击 Open.cmd 打开普通用户权限的桌面端。
3. 可以跳过 Cloud，仅配对局域网手机；Cloud 地址和短码批准流程与安装器相同。
4. 使用 Codex Remote 时，当前 Windows 用户需自行安装并登录 Codex；在 LanPower 的“远程连接”启用自动项目识别，点击“连接原 Codex 窗口”，再打开 Cloud 1.20.1 的“Codex Remote”选择同一电脑和会话。原窗口与网页可同时引导、暂停和管理原生队列；连接失败时按提示手动开启本机调试接口，备用入口为“打开备用共享窗口”。微信小程序 3.1.3 也可从底部 Codex 进入，需先在 Cloud“手机授权”开启 Codex Remote 权限。

这是无需 Setup.exe 的分发包。Windows Service 仍需管理员安装；服务、桌面程序与用户 Codex Host 会复制到 Program Files\LanPower，受保护的配置继续保存在 ProgramData\LanPower。Host 在用户登录后运行，本地远程开发授权默认关闭，按用户保存于 LocalAppData\LanPower。服务不会从可被普通用户修改的解压目录运行。

不要同时从两个分发目录安装。已安装 Setup.exe 的用户优先使用同类型安装器升级。升级保留原局域网配对密钥与加密 Cloud 凭据。解压包不含任何运行时配置、凭据、日志或数据库。

卸载服务：以管理员身份在 Program Files\LanPower 中运行 uninstall-service.ps1；它关闭已安装 Host 并移除登录启动项，保留 ProgramData 中的配对信息与用户授权配置。Setup 安装的应用请使用 Windows“已安装的应用”卸载。

FILES.sha256 校验包内组件；Release 的 SHA256SUMS.txt 校验整个 ZIP 和其他产物。管理员安装、防火墙变更及真实电源动作仍需在可恢复设备上验收。
