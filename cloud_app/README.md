# LanPower Cloud Web 与 Windows Cloud Direct

Cloud Web 是浏览器控制端。Windows 应用可通过一次性配对码连接 Cloud，之后定期上报状态、领取命令并回传结果。在线 Windows 可直接接收状态、睡眠、休眠、重启和关机命令，无需 Wake Gateway。Cloud 保留旧 Gateway 与小程序使用的 `/api/v1/*` 协议；启用旧网关配置后继续兼容。Cloud 从不接收 Windows LAN 配对密钥。

## 本地验证

```powershell
python -m venv cloud_app/.venv
./cloud_app/.venv/Scripts/python.exe -m pip install -e './cloud_app[test]'
./cloud_app/.venv/Scripts/python.exe -m pytest cloud_app/tests -q
```

测试会在临时 SQLite 中运行 Alembic 迁移，分别模拟无网关 Windows Cloud Direct 与旧网关命令回传。测试使用虚构凭据，不会连接实际设备。

## 部署

需要 Docker Compose 和 HTTPS 反向代理。没有 Wake Gateway 时，不需要 `cloud.json` 或 `relay.db`。若从旧版升级，先备份原文件并保留 Gateway/小程序凭据；新 Cloud 可接管旧 `/api/v1` 路径，切换期间避免新旧进程同时写入同一 `relay.db`。

1. 在服务器上运行 `python3 -m cloud_app.password`，复制打印的哈希值。将 `deploy/docker/.env.example` 复制为 `deploy/docker/.env`，把哈希填入 `LANPOWER_ADMIN_PASSWORD_HASH` 的单引号中，并设置实际 HTTPS 域名。`.env`、`private/` 和 `data/` 不应提交。
2. 创建 `deploy/docker/data/` 并使 UID 10001 可写。在 `deploy/docker/` 运行 `docker compose up -d --build`。容器入口只绑定宿主机 `127.0.0.1:8765`；由 Caddy 等反向代理提供 HTTPS。不要把 `8765`、Windows `48211` 或路由器 SSH 直接暴露到公网。
3. 检查本机 `http://127.0.0.1:8765/healthz` 与 HTTPS 登录页。以 `admin` 和设置的密码登录，打开“连接 Windows 电脑”生成一次性配对码，再到 Windows 应用输入 Cloud 地址和配对码。设备在线后可在网页中直接控制。

已有 Gateway 的部署额外使用 `deploy/docker/compose.legacy.yml`：把旧 `cloud.json` 放到 `deploy/docker/private/cloud.json`，其中 `database` 路径为 `/var/lib/lanpower-cloud/relay.db`；将旧 `relay.db` 保留在 `deploy/docker/data/relay.db`。确保 `private/cloud.json` 对容器 UID 10001 可读且权限为 `0600`，然后运行：

```bash
docker compose -f compose.yml -f compose.legacy.yml up -d --build
```

Cloud 初次启动会对新的 `platform.db` 执行 Alembic 迁移。启用旧网关配置后，还会登记现有 Gateway 与一台关联的旧版 Windows 设备。旧 `relay.db` 由原中继逻辑继续使用，不会被迁移脚本修改。更换管理员密码哈希后，现有浏览器登录会失效。

需要在正式切换前单独核对迁移结果时，可先运行 `docker compose -f compose.yml -f compose.legacy.yml run --rm cloud python -m cloud_app.cli migrate-v1`。命令只读取旧 `relay.db` 和 `cloud.json`，将旧 Gateway、Windows 与客户端登记到新的 `platform.db`，不会改写旧数据。

## 当前限制

- 旧 Gateway 仍采用单家庭配对配置；设备表与 API 已按 `owner_id` 和设备关系设计。Windows Device 的凭据已独立，旧小程序的独立客户端授权仍待统一身份阶段。
- 当前 Web 登录为单管理员密码；Passkey、恢复码与新客户端入网仍待统一身份阶段。
- Docker 镜像与真实公网 HTTPS、真实 Windows 电源动作需要在可恢复环境中验收。本阶段自动测试模拟命令回传，未安装到当前工作电脑。
