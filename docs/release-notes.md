# LanPower Cloud Direct

- Windows 提供普通用户桌面端、LocalSystem 服务和安装包，保留旧 LAN API。
- 在线电脑直接连接 Cloud；浏览器或小程序可查看状态、睡眠、休眠、重启和关机，无需网关。
- Cloud 提供 Passkey、恢复码、短码设备批准、独立手机授权、设备移除与审计。
- 可选 Wake Gateway 支持多电脑唤醒和显式启用的备用 LAN 控制。
- 小程序采用局域网优先与 Cloud 回退，并按电脑分别保存本地配对。
- Docker Compose 支持 Caddy 自动 HTTPS、持久化数据及旧协议兼容。
- Windows 支持网络监控、Wi-Fi/离线安装、连接管理、凭据恢复和手动更新检查。

下载 `LanPowerSetup-x64.exe` 安装 Windows 应用。便携分发包需要管理员将服务安装到受保护的目录。网关二进制目标为 Linux ARM64。`SHA256SUMS.txt` 可校验三个发布文件；Cloud 镜像按产品版本及源码提交标记。

当前源码的自动验证通过，管理员安装、防火墙变化、真实 Passkey/微信设备、网关硬件及公网电源动作仍需正式环境验收。此文件是发布说明草稿，正式发布前应按最终验收结果更新；不能把自动测试当作实机验收。
