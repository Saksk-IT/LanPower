# LanPower Cloud Web 与 Windows Cloud Direct

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
4. 打开“连接 Windows 电脑”生成一次性配对码，再到 Windows 应用输入 Cloud 地址和配对码。设备在线后可在网页中直接控制。

已有 Gateway 的部署额外使用 `deploy/docker/compose.legacy.yml`：把旧 `cloud.json` 放到 `deploy/docker/private/cloud.json`，其中 `database` 路径为 `/var/lib/lanpower-cloud/relay.db`；将旧 `relay.db` 保留在 `deploy/docker/data/relay.db`。确保 `private/cloud.json` 对容器 UID 10001 可读且权限为 `0600`，然后运行：

```bash
docker compose -f compose.yml -f compose.legacy.yml up -d --build
```

Cloud 启动时会对 `platform.db` 执行 Alembic 迁移，目前为 `0003_unified_identity`。启用旧网关配置后，还会登记现有 Gateway 与一台关联的旧版 Windows 设备。旧 `relay.db` 由原中继逻辑继续使用，不会被迁移脚本修改。

需要在正式切换前单独核对迁移结果时，可先运行 `docker compose -f compose.yml -f compose.legacy.yml run --rm cloud python -m cloud_app.cli migrate-v1`。命令只读取旧 `relay.db` 和 `cloud.json`，将旧 Gateway、Windows 与客户端登记到新的 `platform.db`，不会改写旧数据。

## 登录与恢复

Passkey 由浏览器与系统提供，可使用 Windows Hello、Face ID、Touch ID 或安全密钥。必须通过 `LANPOWER_PUBLIC_URL` 所配置的 HTTPS 地址访问；域名和协议参与验证，变更域名前应安排凭据迁移。

“设置”中可以添加备用 Passkey，并查看剩余恢复码数量。恢复码只在第一个 Passkey 注册成功时显示，数据库只保存哈希。无法使用 Passkey 时，在登录页展开恢复码入口；成功使用后该码立即失效，旧网页登录会撤销，随后可添加新的 Passkey。请在离开首次展示页面前保存恢复码。

已有部署可保留 `LANPOWER_ADMIN_PASSWORD_HASH`，继续用管理员密码登录，然后在“设置”中添加 Passkey。密码哈希仍可由 `python -m cloud_app.password` 生成；更换哈希会撤销旧网页登录。确认 Passkey 与恢复码已保存后，可从 `.env` 删除该变量并重启以关闭密码入口；已初始化的 `/setup` 不会重新开放。

浏览器会话使用 `Secure`、`HttpOnly`、`SameSite=Strict` Cookie；登录前后均校验 CSRF。Passkey 挑战绑定浏览器或已登录会话，5 分钟到期且只能使用一次。初始化和登录失败会限流，身份事件进入活动记录。Windows 的 15 分钟 Access Token、30 天 Refresh Token、轮换、旧 Token 重用检测和设备撤销继续独立生效。

## 当前限制

- 旧 Gateway 仍采用单家庭配对配置；设备表与 API 已按 `owner_id` 和设备关系设计。Windows Device 的凭据已独立，旧小程序的独立客户端授权仍待统一身份阶段。
- 当前 Web 为单管理员；Passkey 与恢复码已实现。统一设备批准流程、新客户端入网和 Gateway v2 仍待后续实现。
- Docker 镜像与真实公网 HTTPS、真实 Windows 电源动作需要在可恢复环境中验收。本阶段自动测试模拟命令回传，未安装到当前工作电脑。
