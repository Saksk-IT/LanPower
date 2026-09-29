# 5G / 外网控制实现状态

当前版本：v1.1.0 Remote Gateway Preview。

家庭端已有的实机验证确认：实际路由器为 Xiaomi AX3000T / RD03（MT7981、aarch64）；`/data` 持久化、ARM64 Go WOL、路由器访问 Windows `48211`、公网 HTTPS GET/POST，以及 UCI firewall include 自启动均已确认。本次开发直接使用这些前提，没有重复做硬件研究。

软件现已包含三个部分：

1. `router_gateway/`：在路由器上用 outbound HTTPS 长轮询取命令，内置 WOL，调用 Windows 原有 LAN API；校验时效、动作和重放。
2. `cloud_remote/`：独立 Gateway 和手机凭据、SQLite 命令队列与结果、心跳、限速；只绑定 loopback，外部使用 HTTPS 反向代理。
3. `mini_program/`：先试原有 LAN Direct；若不可达且已配置远程配对，自动查询 Cloud 并使用 Router Gateway，界面显示当前路径。

Windows 服务及局域网 WOL 保持原行为。Cloud 不保存 LAN Token，不转发任意 HTTP，也不要求路由器或 Windows 开放公网端口。

部署步骤及仍需在实际环境完成的验证见 [Cloud 说明](../cloud_remote/README.md)、[Gateway 说明](../router_gateway/README.md)。缺少实际 HTTPS 域名、私有配置与设备部署时，发布包只是可部署的预览实现，不能声称 5G 真机链路已经打通。
