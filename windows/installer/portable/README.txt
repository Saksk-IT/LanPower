LanPower Windows 便携分发包

1. 解压到本机目录，双击 Install.cmd，并允许 Windows 管理员授权。
2. 安装完成后，双击 Open.cmd 打开普通用户权限的桌面端。
3. 可以跳过 Cloud，仅配对局域网手机；Cloud 地址和短码批准流程与安装器相同。

这是无需 Setup.exe 的分发包。Windows Service 仍需管理员安装；服务与桌面程序会复制到 Program Files\LanPower，受保护的配置继续保存在 ProgramData\LanPower。服务不会从可被普通用户修改的解压目录运行。

不要同时从两个分发目录安装。已安装 Setup.exe 的用户优先使用同类型安装器升级。升级保留原局域网配对密钥与加密 Cloud 凭据。解压包不含任何运行时配置、凭据、日志或数据库。

卸载服务：以管理员身份在 Program Files\LanPower 中运行 uninstall-service.ps1；它保留 ProgramData 中的配对信息。Setup 安装的应用请使用 Windows“已安装的应用”卸载。

FILES.sha256 校验包内组件；Release 的 SHA256SUMS.txt 校验整个 ZIP 和其他产物。管理员安装、防火墙变更及真实电源动作仍需在可恢复设备上验收。
