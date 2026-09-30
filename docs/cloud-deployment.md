# Cloud 部署

推荐在 Linux 服务器使用 Docker Compose。新部署的 Caddy 配置负责 HTTPS，Cloud 默认采用 SQLite，数据和证书持久保存在 Docker 数据卷。详细命令见 [Docker 快速部署](../deploy/docker/README.md)。

## 配置选择

| 场景 | 设置 |
|---|---|
| 全新部署 | `.env.example` 复制为 `.env`；填写 `LANPOWER_DOMAIN`，保留 `COMPOSE_PROFILES=https` 和 `LANPOWER_DATA_MOUNT=cloud-data` |
| 已有 HTTPS 代理 | `COMPOSE_PROFILES` 留空，设置实际 `LANPOWER_PUBLIC_URL`，代理到 `127.0.0.1:8765` |
| 已有目录数据 | 保留 `.env`；`LANPOWER_DATA_MOUNT=./data` 或不设置，目录需允许 UID 10001 写入 |
| 旧版 Gateway | 叠加 `compose.legacy.yml`，挂载原 `cloud.json` 与 `relay.db` |

Windows 和网关只向 Cloud 发起出站 HTTPS，不需要额外入站端口。公网只开放 80/443，Cloud 应用本身的 8765 仅绑定回环。只有浏览器与 Windows 时，不配置旧 Gateway 文件也能运行。

## 初始化

启动后，检查 `/healthz`。通过 `docker compose exec cloud cat /var/lib/lanpower-cloud/setup-code` 读取服务器上的初始化码。在实际域名的 `/setup` 创建管理员 Passkey，保存首次显示的 10 个恢复码。初始化完成后关闭 `/setup`，不会在重启后重新开放。

Passkey 验证绑定 HTTPS 地址，`LANPOWER_PUBLIC_URL` 应与用户实际访问地址一致。改变域名或协议需要重新安排 Passkey 和设备注册，不要随意切换。

## 旧版兼容

保留原 `.env`、LAN/Gateway/Client 凭据和原数据库。将私有 `cloud.json` 放入 `deploy/docker/private/`，其中旧数据库路径设为 `/var/lib/lanpower-cloud/relay.db`。旧数据挂载继续指向原目录，然后执行：

```sh
docker compose -f compose.yml -f compose.legacy.yml up -d --build
```

旧配置由服务器保存，不需要上传到网页。新 Cloud 会登记 Legacy Gateway、Windows 和客户端；`/api/v1/*` 继续由兼容协议处理。原 Gateway 无需立刻重新安装。

## 更新

先 [备份数据](migration-v1.md)，再使用经过验证的源码或固定镜像更新。Cloud 启动自动升级平台数据库，当前迁移为 `0006_gateway_commands`。不要使用本地测试数据库覆盖服务器数据，不要运行 `docker compose down -v`。

更新后分别检查本机与公网 `/healthz`、网页登录、设备状态和只读状态命令，再安排真实电源验收。证书申请、外网可达性和真实设备仍需在目标服务器上确认。

## 本地部署验证（2026-09-30）

Cloud Docker 镜像已成功构建；容器以 UID 10001 在全新数据卷启动，平台数据库迁移到 `0006_gateway_commands`，重启后数据保留。`lanpower-cloud migrate-v1` 命令入口可用。Caddy 2.11.4 配置校验与本地测试证书 HTTPS 转发通过。完整 Compose 的 Cloud + Caddy 启动、Cloud 健康检查及 HTTPS 访问均通过。文档中的 SQLite 备份命令已执行，备份恢复至独立数据卷后，完整性检查、数据和 Cloud 启动均通过。验证资源均为隔离测试数据。

公网域名 DNS、真实证书签发、目标服务器端口与真实设备未由这些本地检查证明，仍需正式环境验收。
