# LanPower Cloud Web（Milestone 2）

Cloud Web 是新的浏览器控制端，保留现有 Gateway 与小程序使用的 `/api/v1/*` 协议。当前先提供单管理员账户、设备列表、操作记录与旧版 Gateway 控制；Windows Cloud Direct 和统一设备注册将在后续里程碑实现。Web 从不接收 Windows LAN Token。

## 本地验证

```powershell
python -m venv cloud_app/.venv
./cloud_app/.venv/Scripts/python.exe -m pip install -e './cloud_app[test]'
./cloud_app/.venv/Scripts/python.exe -m pytest cloud_app/tests -q
```

测试会在临时 SQLite 中运行 Alembic 迁移，并模拟 Gateway 心跳、浏览器命令、网关取命令和结果回传。测试使用虚构凭据，不会连接实际设备。

## 部署

需要 Docker Compose、现有的 `cloud.json`、已保存的 `relay.db` 和一个 HTTPS 反向代理。先备份原 `cloud.json` 与 `relay.db`，保留原 Gateway/小程序凭据。新 Cloud 可以直接接管旧 `/api/v1` 路径；切换期间应避免新旧进程同时对同一 `relay.db` 写入。

1. 将 `deploy/docker/compose.yml` 与仓库源码放在同一目录结构下，把 `cloud.json` 放到 `deploy/docker/private/cloud.json`。文件中 `database` 路径应为 `/var/lib/lanpower-cloud/relay.db`；如果旧部署已有该路径，可原样保留。将旧 `relay.db` 复制到 `deploy/docker/data/relay.db`，不要用本地空库覆盖已有生产数据库。
2. 在服务器上运行 `python3 -m cloud_app.password`，复制打印的哈希值。将 `deploy/docker/.env.example` 复制为 `deploy/docker/.env`，把哈希填入 `LANPOWER_ADMIN_PASSWORD_HASH` 的单引号中，并设置实际 HTTPS 域名。`.env`、`private/` 和 `data/` 不应提交。
3. 将 `private/cloud.json` 设置为 UID 10001 可读且仅本人可读（`0600`）；将 `data/` 设置为 UID 10001 可写。容器以该 UID 运行，无法读取权限过宽的旧配置。
4. 在 `deploy/docker/` 运行 `docker compose up -d --build`。入口只绑定宿主机 `127.0.0.1:8765`。让 Caddy 等反向代理提供 HTTPS，并代理到该地址；不要直接暴露 `8765`、Windows `48211` 或路由器 SSH 到公网。
5. 检查 `http://127.0.0.1:8765/healthz` 与 HTTPS 登录页，确认旧 Gateway 与小程序仍能访问 `/api/v1`。浏览器以 `admin` 和刚设置的密码登录。

Cloud 初次启动会对新的 `platform.db` 执行 Alembic 迁移，并登记现有 Gateway 与一台关联的旧版 Windows 设备。旧 `relay.db` 由原中继逻辑继续使用，不会被迁移脚本修改。更换管理员密码哈希后，现有浏览器登录会失效。

需要在正式切换前单独核对迁移结果时，可先运行 `docker compose run --rm cloud python -m cloud_app.cli migrate-v1`。命令只读取旧 `relay.db` 和 `cloud.json`，将旧 Gateway、Windows 与客户端登记到新的 `platform.db`，不会改写旧数据。

## 当前限制

- 旧 Gateway 仍采用单家庭配对配置；设备表与 API 已按 `owner_id` 和设备关系设计，后续可扩展多用户、多台 Windows。
- Windows Cloud Agent、Cloud Direct、每设备凭据与独立客户端撤销属于后续里程碑。
- 真实路由器和真实 Windows 电源动作需要在已备份、可恢复的环境中手动验收。本阶段自动测试只模拟命令回传。
