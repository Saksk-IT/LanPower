# 5G / 外网控制实现状态

当前版本：v1.1.2 Remote Gateway Preview。

家庭端已有的实机验证确认：实际路由器为 Xiaomi AX3000T / RD03（MT7981、aarch64）；`/data` 持久化、ARM64 Go WOL、路由器访问 Windows `48211`、公网 HTTPS GET/POST，以及 UCI firewall include 自启动均已确认。本次开发直接使用这些前提，没有重复做硬件研究。

软件现已包含三个部分：

1. `router_gateway/`：在路由器上用 outbound HTTPS 长轮询取命令，内置 WOL，调用 Windows 原有 LAN API；校验时效、动作和重放。
2. `cloud_remote/`：独立 Gateway 和手机凭据、SQLite 命令队列与结果、心跳、限速；只绑定 loopback，外部使用 HTTPS 反向代理。
3. `mini_program/`：先试原有 LAN Direct；若不可达且已配置远程配对，自动查询 Cloud 并使用 Router Gateway，界面显示当前路径。状态查询与唤醒能力分开判断：Cloud 和 Gateway 失联时，保留本地配对即可发送局域网 WOL。

Windows 服务及局域网 WOL 保持原行为。Gateway 升级时先校验候选程序，启动健康检查失败会自动恢复旧程序及启动设置，配置和凭据保持原样。SSH 恢复由路由器上的 `maintenance.conf` 显式控制；新安装默认为关闭，旧 Gateway 升级时保留原来的恢复能力。Cloud 不保存 LAN Token，不转发任意 HTTP，也不要求路由器或 Windows 开放公网端口。

自动化测试覆盖 Windows LAN API、Cloud、手机端状态和 WOL 路由、Gateway 安装回滚及 Go 程序；CI 还构建 Linux ARM64 静态二进制。2026 年 9 月 29 日，一套实际环境通过 Cloudflare 代理域名、Caddy 和 systemd 运行 Cloud，并在 AX3000T 上安装 Gateway。公网鉴权状态接口返回 Gateway 与 PC 在线；公网只读 `status` 命令经 Gateway 查询 Windows 后返回在线。Gateway 安装模拟测试通过，路由器自启动项和配置权限已检查。手机小程序仍需完成 AppID、HTTPS 合法域名、扫码预览和 5G 真机操作验证。部署步骤见 [Cloud 说明](../cloud_remote/README.md)、[Gateway 说明](../router_gateway/README.md)。
