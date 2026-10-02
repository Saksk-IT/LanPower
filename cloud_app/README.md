# LanPower Cloud Web 与 Windows Cloud Direct

当前源码版本：Cloud `1.11.0`，Codex Remote 提供接近原生的项目会话列表、消息详情、执行过程与底部输入栏；桌面已保存的进度每 2 秒更新。内存 Relay 不保存正文。Cloud 187 项测试及浏览器 1440/390/320px 检查通过。本轮仅更新本机 Docker，正式 Cloud 仍为 `1.7.2`；当前公开版本仍为 `1.6.1`，镜像 `ghcr.io/saksk-it/lanpower-cloud:1.6.1`。v1.7 的计划任务、实时状态、手机权限与微信离线通知见 [升级说明](../docs/upgrade-v1.7.md)。数据库迁移仍为 `0009_automation`，升级前需使用 SQLite backup API 备份数据库及私有配置；保留原数据卷。

1.11 新增会话自动释放和菜单“交还桌面”，按会话隔离活动任务与审批；存在未结束任务或后台命令时保留连接。官方 Runtime 验证占用、释放和同会话恢复，原生桌面当前的活动任务仍只能同步查看。

## Codex Remote Relay

登录后在 `/remote` 选择本账户的 Windows。浏览器沿用安全会话 Cookie，连接必须来自配置的同一 Origin；Agent 使用独立 Windows Bearer 凭据，不能借用手机或网关凭据。连接使用 `lanpower.codex.v1` WSS 子协议，令牌不得放在 URL。每台设备仅一个控制页面，撤销设备或登录会话后关闭连接。复用既有唤醒接口，不改变电源路由。

Relay 只在限额内存队列中转发 JSON-RPC；任务、代码、Diff、审批内容和 OpenAI 登录信息不写数据库、日志或 PWA 缓存。审计仅记录账户/设备编号、事件类型和时间。TLS 在 Cloud 终止，服务会短暂看到转发正文，当前 MVP 不提供端到端加密。使用自己的可信 Cloud；详见 [安全边界](../docs/security-model.md)、[使用说明](../docs/codex-remote.md) 和 [协议](../docs/codex-remote-protocol.md)。

当前 Relay 为进程内路由，部署保持 **单个 Uvicorn worker / 单个 Cloud 副本**。Caddy 支持现有 HTTPS 入口的 WebSocket 升级；其他代理也必须转发 Upgrade，保留 `Origin` 和 Cookie，禁用正文采样并允许长连接。多副本共享路由、外部消息总线和移动端专用授权留待后续阶段。

Cloud“手机授权”支持为每部手机生成一次性二维码，并逐个撤销。Cloud `1.7.2` 配合小程序 `2.0.5` 支持一次扫码长期授权：访问凭据每 15 分钟续期，手机长期凭据不因断网、响应丢失、重启或长期闲置过期；Gateway 续期也通过不消费长期凭据的重试接口恢复。新版小程序通过独立会话读取设备列表并按电脑编号控制；客户端凭据与 Windows、Gateway、浏览器身份分开。升级顺序和旧凭据恢复边界见 [小程序 v2](../docs/mini-program-v2.md#长期授权升级)。

Cloud Web 是浏览器控制端，默认使用 Passkey 登录。Windows 应用可通过一次性配对码连接 Cloud，之后定期上报状态、领取命令并回传结果。在线 Windows 可直接接收状态、睡眠、休眠、重启和关机命令，无需 Wake Gateway。Cloud 保留旧 Gateway 与小程序使用的 `/api/v1/*` 协议；启用旧网关配置后继续兼容。Cloud 从不接收 Windows LAN 配对密钥。

## 控制台分工

Cloud 1.7.2 的总览按电脑直接展示五个电源操作，不再提供设备分组或批量操作；远程桌面下载连接文件并提示下一步，“我的电脑”负责电脑详情与管理，“远程唤醒”负责网关和关联，“手机授权”负责扫码与撤销。服务信息并入设置；旧链接兼容跳转。连接步骤、界面行为和验证记录见 [Cloud 界面指南](../docs/cloud-ui.md)。

## 本地验证

需要在浏览器中开发测试时，可在仓库根目录运行 `./deploy/docker/start-dev.ps1`，启动独立 Docker 环境并访问 **https://localhost:8443**。源码自动重载、开发账户、证书与数据保留方式见 [本机开发指南](../docs/local-development.md)。

```powershell
python -m venv cloud_app/.venv
./cloud_app/.venv/Scripts/python.exe -m pip install -e './cloud_app[test]'
./cloud_app/.venv/Scripts/python.exe -m pytest cloud_app/tests -q
```

测试会在临时 SQLite 中运行 Alembic 迁移，分别模拟无网关 Windows Cloud Direct 与旧网关命令回传。身份测试使用临时 P-256 密钥生成真实 WebAuthn 注册数据和签名，覆盖挑战过期、浏览器绑定、重放、错误域名、用户验证、一次性恢复码、并发初始化和管理员撤销。测试使用虚构凭据，不会连接实际设备。

## 部署

需要 Docker Compose 和 HTTPS。新部署可使用内置 Caddy 自动配置 HTTPS，详见 [Docker 快速部署](../deploy/docker/README.md)。没有 Wake Gateway 时，不需要 `cloud.json` 或 `relay.db`。若从旧版升级，先备份原文件并保留 Gateway/小程序凭据；新 Cloud 可接管旧 `/api/v1` 路径，切换期间避免新旧进程同时写入同一 `relay.db`。

1. 新安装将 `deploy/docker/.env.example` 复制为 `deploy/docker/.env`，设置实际 `LANPOWER_DOMAIN`；`LANPOWER_PUBLIC_URL` 随之生成。已有安装保留原 `.env` 和数据挂载。新安装无需设置管理员密码。`.env`、`private/`、`data/` 和 `backups/` 不应提交。
2. 在 `deploy/docker/` 运行 `docker compose up -d --build`。新示例默认启用 Caddy 和 Cloud 数据卷；已有 `./data` 目录需保持 UID 10001 可写。应用入口只绑定宿主机 `127.0.0.1:8765`；公网 HTTPS 由 Caddy 提供。已有反向代理时将 `COMPOSE_PROFILES` 留空。不要把 `8765`、Windows `48211` 或路由器 SSH 直接暴露到公网。
3. 检查本机 `http://127.0.0.1:8765/healthz`。在服务器运行 `docker compose exec cloud cat /var/lib/lanpower-cloud/setup-code` 读取初始化验证码，并在自己的 HTTPS 地址打开 `/setup`。填入验证码，按浏览器提示创建管理员 `admin` 的 Passkey，保存随后显示的 10 个恢复码，再进入控制台。验证码不会写入应用日志；初始化完成后会删除验证码文件并永久关闭 `/setup`，重启也不会重新开放。
4. 在 Windows 应用中填写 Cloud 地址并点击“连接 Cloud”，电脑将显示短配对码。打开 Cloud 的 `/enroll`（也可从“连接电脑”进入），输入短码、核对设备名称并允许连接。设备在线后可在网页中直接控制。旧版 Windows 仍可使用网页生成的一次性长配对码。

已有 Gateway 的部署额外使用 `deploy/docker/compose.legacy.yml`：把旧 `cloud.json` 放到 `deploy/docker/private/cloud.json`，其中 `database` 路径为 `/var/lib/lanpower-cloud/relay.db`；将旧 `relay.db` 保留在 `deploy/docker/data/relay.db`。确保 `private/cloud.json` 对容器 UID 10001 可读且权限为 `0600`，然后运行：

```bash
docker compose -f compose.yml -f compose.legacy.yml up -d --build
```

Cloud 启动时会对 `platform.db` 执行 Alembic 迁移，目前为 `0008_persistent_clients`。未撤销手机的刷新期限改为长期，保留手机编号、凭据哈希、历史和撤销状态；未上报应用版本的记录显示“尚未上报”。已撤销或已消费后丢失的旧凭据不会恢复，必要时需最后扫码一次。启用旧网关配置后，还会登记现有 Gateway 与一台关联的旧版 Windows 设备。旧 `relay.db` 由原中继逻辑继续使用，不会被迁移脚本修改。

需要在正式切换前单独核对迁移结果时，可先运行 `docker compose -f compose.yml -f compose.legacy.yml run --rm cloud python -m cloud_app.cli migrate-v1`。命令只读取旧 `relay.db` 和 `cloud.json`，将旧 Gateway、Windows 与客户端登记到新的 `platform.db`，不会改写旧数据。

## 登录与恢复

Passkey 由浏览器与系统提供，可使用 Windows Hello、Face ID、Touch ID 或安全密钥。必须通过 `LANPOWER_PUBLIC_URL` 所配置的 HTTPS 地址访问；域名和协议参与验证，变更域名前应安排凭据迁移。

“设置”中可以添加备用 Passkey，并查看剩余恢复码数量。恢复码只在第一个 Passkey 注册成功时显示，数据库只保存哈希。无法使用 Passkey 时，在登录页展开恢复码入口；成功使用后该码立即失效，旧网页登录会撤销，随后可添加新的 Passkey。请在离开首次展示页面前保存恢复码。

已有部署可保留 `LANPOWER_ADMIN_PASSWORD_HASH`，继续用管理员密码登录，然后在“设置”中添加 Passkey。密码哈希仍可由 `python -m cloud_app.password` 生成；更换哈希会撤销旧网页登录。确认 Passkey 与恢复码已保存后，可从 `.env` 删除该变量并重启以关闭密码入口；已初始化的 `/setup` 不会重新开放。

浏览器会话使用 `Secure`、`HttpOnly`、`SameSite=Strict` Cookie；登录前后均校验 CSRF。Passkey 挑战绑定浏览器或已登录会话，5 分钟到期且只能使用一次。初始化和登录失败会限流，身份事件进入活动记录。Windows 的 15 分钟 Access Token、30 天 Refresh Token、轮换、旧 Token 重用检测和设备撤销继续独立生效。

## 设备批准与撤销

新设备使用 `POST /api/v2/enroll/start` 发起配对，提交 `device_type`（`windows` 或 `gateway`）、`name`、`version` 和 `protocol_version: "2"`。返回的 `device_code` 留在设备服务中；用户只需核对短 `user_code`，并在 `verification_uri` 登录后批准。两种码均在 10 分钟后失效，数据库只保存哈希。

设备按返回的 `interval` 调用 `POST /api/v2/enroll/token`，请求体为 `{"device_code":"..."}`。未批准时返回 `authorization_pending`，过快轮询返回 `slow_down`，拒绝或过期分别返回 `access_denied`、`expired_token`。批准后仅能兑换一次独立设备凭据；短配对码不能兑换凭据。`POST /api/v2/devices/token` 为 Windows 和网关提供统一刷新入口，Windows 原 `/api/v2/windows/token` 仍兼容。网关凭据不能调用 Windows 协议。

“我的电脑”或“远程唤醒”的“名称与管理”中的“移除设备”会撤销该设备及其所有会话。批准、拒绝、连接和撤销均记录审计。旧版网关使用共享配置，需由部署者在服务器上移除其配置。

已知设备或客户端凭据过期、撤销或身份校验失败时，活动页记录授权失败；五分钟内重复失败会合并，未知凭据不会被归到请求者指定的账户。设备与旧手机轮换接口的旧凭据重用仍会撤销会话并记录异常；新版手机的 `/api/v2/clients/renew` 保留长期凭据，允许重试，不触发重用撤销。记录中不保存 Token、授权头或其哈希，详见 [认证与授权](../docs/authentication-v2.md)。

## 当前限制

- 当前 Web 为单管理员；设备表与 API 已按 `owner_id` 和设备关系设计。旧 `/api/v1/*` 保留单家庭配置。
- 小程序 v2 使用独立客户端授权，见 [小程序 v2](../docs/mini-program-v2.md)；微信原生扫码与真机网络切换尚待验收。
- Docker 镜像构建、普通用户容器启动、新数据卷、重启数据保留和 Caddy 本地 HTTPS 已通过；正式平台数据库、Caddy 证书与配置卷的隔离联合恢复也已通过。指定公网环境的 Cloudflare 入口、正式 HTTPS 证书、真实 Passkey 初始化及无网关 Windows 只读状态链路已通过；物理电源动作尚待用户手动验收。进展见 [开发与验收清单](../docs/implementation-checklist.md)。

## Wake Gateway v2

注册网关后，在“远程唤醒”页面选择电脑，点击“使用这个网关”。桌面入口会通过 `?computer=` 预选本机，服务器仅接受当前账户的电脑。新版网关自动从该电脑的局域网接口获取并保存唤醒信息，网页显示配置进度和失败原因，无需另填本地配置；仅做 WOL 无需 Windows LAN Token。启用备用控制时，仍需手工配置 LAN 凭据，Cloud 关联与网关本地 `backup_relay` 必须同时允许，且网关报告局域网电脑在线。Windows 云端在线时始终优先 `windows_direct`，离线唤醒走 `wake_gateway`，备用控制走 `gateway_relay`。多网关关联会选择满足条件的在线网关。

Windows 心跳响应以 `wake_setup_protocol: 1` 协商自动配置；后续心跳的 `wake_profile` 只携带短效只读票据、端口及过期时间。网关通过 `POST /api/v2/gateway/wake-setup` 领取同账户已关联电脑的票据、上报配置结果。MAC、广播地址仍由网关直接从局域网读取，LAN Token 不参与此过程。网页、普通状态 API 与审计不暴露票据；未持久保存或只有配置结果而没有网关能力心跳时，不开放开机按钮。旧客户端继续兼容，界面会提示升级对应组件。

网关使用 `/api/v2/gateway/heartbeat`、`commands`、`results`，不能调用 Windows 协议。命令同时绑定网关和 Windows，45 秒有效；轮询原子领取，重试结果保持幂等。移除设备或修改关联会取消未完成队列；已经送达的电源动作无法撤回。被移除的 Windows 不再计入网关状态，其余电脑仍可用。

安装、配置、协议和验证边界见 [Wake Gateway](../docs/wake-gateway.md)。此前自动配置更新后 Cloud 共 108 项测试通过，包含旧版兼容、无路由器直连、多电脑网关与撤销隔离、授权失败审计、客户端版本迁移、状态同步、票据隔离及自动配置流程；网页关联和设备详情已在桌面和手机宽度验证。当前 `/healthz` 返回 Cloud 版本 `1.6.0` 与协议版本 `2`，长期授权修复的本地验证见 [小程序 v2](../docs/mini-program-v2.md#本地验证2026-09-30)。

Windows 状态上报的响应额外提供该电脑的 `wake_gateway` 和 `wake_available`，用于桌面端显示实际连接情况；不会暴露其他电脑或设备凭据。设备列表提供版本、最近连接、局域网地址和系统唤醒能力，网页在开机不可用时区分未配置网关、网关离线和网关尚未配置电脑。

## 状态同步

总览、我的电脑和远程唤醒页每 5 秒自动更新状态，失败时显示“状态未知”并禁用远程电源按钮。Windows 每 10 秒独立上报心跳，新服务失联 35 秒后判定直连离线；旧服务仍按 75 秒处理。非局域网模式的小程序采用同一 Cloud 设备状态，网络切换后的旧响应不能覆盖新结果。

电脑可由有效的 Windows 心跳或网关局域网观察确认为在线，备用控制仍需单独授权。已上报的电源过渡或离线状态不会被网关的旧观察覆盖。状态同步功能引入时的 97 项 Cloud 测试及网页状态脚本回归通过；Cloud `1.6.0` 更新后共 119 项测试通过，升级顺序、协议兼容和验收边界见 [三端状态同步](../docs/status-sync.md) 与 [界面指南](../docs/cloud-ui.md)。
