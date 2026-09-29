# LanPower Cloud Web 与 Windows Cloud Direct

Cloud“已授权客户端”现在支持为每部手机生成一次性二维码，并逐个撤销。新版小程序通过独立会话读取设备列表并按电脑编号控制；客户端凭据与 Windows、Gateway、浏览器身份分开。使用与验证边界见 [小程序 v2](../docs/mini-program-v2.md)。

Cloud Web 是浏览器控制端，默认使用 Passkey 登录。Windows 应用可通过一次性配对码连接 Cloud，之后定期上报状态、领取命令并回传结果。在线 Windows 可直接接收状态、睡眠、休眠、重启和关机命令，无需 Wake Gateway。Cloud 保留旧 Gateway 与小程序使用的 `/api/v1/*` 协议；启用旧网关配置后继续兼容。Cloud 从不接收 Windows LAN 配对密钥。

## 本地验证

```powershell
python -m venv cloud_app/.venv
./cloud_app/.venv/Scripts/python.exe -m pip install -e './cloud_app[test]'
./cloud_app/.venv/Scripts/python.exe -m pytest cloud_app/tests -q
```

测试会在临时 SQLite 中运行 Alembic 迁移，分别模拟无网关 Windows Cloud Direct 与旧网关命令回传。身份测试使用临时 P-256 密钥生成真实 WebAuthn 注册数据和签名，覆盖挑战过期、浏览器绑定、重放、错误域名、用户验证、一次性恢复码、并发初始化和管理员撤销。测试使用虚构凭据，不会连接实际设备。

## 部署

需要 Docker Compose 和 HTTPS 反向代理。没有 Wake Gateway 时，不需要 `cloud.json` 或 `relay.db`。若从旧版升级，先备份原文件并保留 Gateway/小程序凭据；新 Cloud 可接管旧 `/api/v1` 路径，切换期间避免新旧进程同时写入同一 `relay.db`。

1. 将 `deploy/docker/.env.example` 复制为 `deploy/docker/.env`，设置实际 HTTPS 域名 `LANPOWER_PUBLIC_URL`。新安装无需设置管理员密码。`.env`、`private/` 和 `data/` 不应提交。
2. 创建 `deploy/docker/data/` 并使 UID 10001 可写。在 `deploy/docker/` 运行 `docker compose up -d --build`。容器入口只绑定宿主机 `127.0.0.1:8765`；由 Caddy 等反向代理提供 HTTPS。不要把 `8765`、Windows `48211` 或路由器 SSH 直接暴露到公网。
3. 检查本机 `http://127.0.0.1:8765/healthz`。在服务器运行 `docker compose exec cloud cat /var/lib/lanpower-cloud/setup-code` 读取初始化验证码，并在自己的 HTTPS 地址打开 `/setup`。填入验证码，按浏览器提示创建管理员 `admin` 的 Passkey，保存随后显示的 10 个恢复码，再进入控制台。验证码不会写入应用日志；初始化完成后会删除验证码文件并永久关闭 `/setup`，重启也不会重新开放。
4. 在 Windows 应用中填写 Cloud 地址并点击“连接 Cloud”，电脑将显示短配对码。打开 Cloud 的 `/enroll`（也可从“连接 Windows 电脑”进入），输入短码、核对设备名称并允许连接。设备在线后可在网页中直接控制。旧版 Windows 仍可使用网页生成的一次性长配对码。

已有 Gateway 的部署额外使用 `deploy/docker/compose.legacy.yml`：把旧 `cloud.json` 放到 `deploy/docker/private/cloud.json`，其中 `database` 路径为 `/var/lib/lanpower-cloud/relay.db`；将旧 `relay.db` 保留在 `deploy/docker/data/relay.db`。确保 `private/cloud.json` 对容器 UID 10001 可读且权限为 `0600`，然后运行：

```bash
docker compose -f compose.yml -f compose.legacy.yml up -d --build
```

Cloud 启动时会对 `platform.db` 执行 Alembic 迁移，目前为 `0006_gateway_commands`。启用旧网关配置后，还会登记现有 Gateway 与一台关联的旧版 Windows 设备。旧 `relay.db` 由原中继逻辑继续使用，不会被迁移脚本修改。

需要在正式切换前单独核对迁移结果时，可先运行 `docker compose -f compose.yml -f compose.legacy.yml run --rm cloud python -m cloud_app.cli migrate-v1`。命令只读取旧 `relay.db` 和 `cloud.json`，将旧 Gateway、Windows 与客户端登记到新的 `platform.db`，不会改写旧数据。

## 登录与恢复

Passkey 由浏览器与系统提供，可使用 Windows Hello、Face ID、Touch ID 或安全密钥。必须通过 `LANPOWER_PUBLIC_URL` 所配置的 HTTPS 地址访问；域名和协议参与验证，变更域名前应安排凭据迁移。

“设置”中可以添加备用 Passkey，并查看剩余恢复码数量。恢复码只在第一个 Passkey 注册成功时显示，数据库只保存哈希。无法使用 Passkey 时，在登录页展开恢复码入口；成功使用后该码立即失效，旧网页登录会撤销，随后可添加新的 Passkey。请在离开首次展示页面前保存恢复码。

已有部署可保留 `LANPOWER_ADMIN_PASSWORD_HASH`，继续用管理员密码登录，然后在“设置”中添加 Passkey。密码哈希仍可由 `python -m cloud_app.password` 生成；更换哈希会撤销旧网页登录。确认 Passkey 与恢复码已保存后，可从 `.env` 删除该变量并重启以关闭密码入口；已初始化的 `/setup` 不会重新开放。

浏览器会话使用 `Secure`、`HttpOnly`、`SameSite=Strict` Cookie；登录前后均校验 CSRF。Passkey 挑战绑定浏览器或已登录会话，5 分钟到期且只能使用一次。初始化和登录失败会限流，身份事件进入活动记录。Windows 的 15 分钟 Access Token、30 天 Refresh Token、轮换、旧 Token 重用检测和设备撤销继续独立生效。

## 设备批准与撤销

新设备使用 `POST /api/v2/enroll/start` 发起配对，提交 `device_type`（`windows` 或 `gateway`）、`name`、`version` 和 `protocol_version: "2"`。返回的 `device_code` 留在设备服务中；用户只需核对短 `user_code`，并在 `verification_uri` 登录后批准。两种码均在 10 分钟后失效，数据库只保存哈希。

设备按返回的 `interval` 调用 `POST /api/v2/enroll/token`，请求体为 `{"device_code":"..."}`。未批准时返回 `authorization_pending`，过快轮询返回 `slow_down`，拒绝或过期分别返回 `access_denied`、`expired_token`。批准后仅能兑换一次独立设备凭据；短配对码不能兑换凭据。`POST /api/v2/devices/token` 为 Windows 和网关提供统一刷新入口，Windows 原 `/api/v2/windows/token` 仍兼容。网关凭据不能调用 Windows 协议。

“我的设备”中的“移除设备”会撤销该设备及其所有会话。批准、拒绝、连接和撤销均记录审计。旧版网关使用共享配置，需由部署者在服务器上移除其配置。

## 当前限制

- 当前 Web 为单管理员；设备表与 API 已按 `owner_id` 和设备关系设计。旧 `/api/v1/*` 保留单家庭配置。
- 小程序 v2 使用独立客户端授权，见 [小程序 v2](../docs/mini-program-v2.md)；微信原生扫码与真机网络切换尚待验收。
- Docker 镜像与真实公网 HTTPS、真实 Windows 电源动作需要在可恢复环境中验收。本阶段自动测试模拟命令回传，未安装到当前工作电脑。

## Wake Gateway v2

注册网关后，在“唤醒网关”页面关联电脑。网关本地也要有该电脑的配置；仅做 WOL 无需 Windows LAN Token。启用备用控制时，Cloud 关联与网关本地 `backup_relay` 必须同时允许，且网关报告局域网电脑在线。Windows 云端在线时始终优先 `windows_direct`，离线唤醒走 `wake_gateway`，备用控制走 `gateway_relay`。多网关关联会选择满足条件的在线网关。

网关使用 `/api/v2/gateway/heartbeat`、`commands`、`results`，不能调用 Windows 协议。命令同时绑定网关和 Windows，45 秒有效；轮询原子领取，重试结果保持幂等。移除设备或修改关联会取消未完成队列；已经送达的电源动作无法撤回。被移除的 Windows 不再计入网关状态，其余电脑仍可用。

安装、配置、协议和验证边界见 [Wake Gateway](../docs/wake-gateway.md)。本地 Cloud 共 64 项测试通过，包含旧版兼容、无路由器直连、多电脑网关与撤销隔离；网页关联和设备详情已在桌面和手机宽度验证。

Windows 状态上报的响应额外提供该电脑的 `wake_gateway` 和 `wake_available`，用于桌面端显示实际连接情况；不会暴露其他电脑或设备凭据。设备列表提供版本、最近连接、局域网地址和系统唤醒能力，网页在开机不可用时区分未配置网关、网关离线和网关尚未配置电脑。
