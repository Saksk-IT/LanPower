# Cloud Docker 快速部署

本机开发测试使用独立的 `compose.dev.yml`：在仓库根目录运行 `./deploy/docker/start-dev.ps1`，访问 **https://localhost:8443**。脚本准备本地证书和随机开发密码，复用已有测试数据；详见 [本机开发指南](../../docs/local-development.md)。以下为正式 HTTPS 部署流程。

新部署默认由 Caddy 自动提供 HTTPS，Windows 和 Wake Gateway 只建立出站连接。

## 新安装

服务器需安装 Docker Compose，将自己的域名解析到服务器，并允许公网访问 TCP 80/443（UDP 443 可选）。在本目录执行：

```sh
cp .env.example .env
```

修改 `.env` 的 `LANPOWER_DOMAIN` 为自己的域名，保留 `COMPOSE_PROFILES=https` 和 `LANPOWER_DATA_MOUNT=cloud-data`，然后运行：

```sh
docker compose up -d --build
docker compose ps
docker compose exec cloud cat /var/lib/lanpower-cloud/setup-code
```

在自己的 `https://域名/setup` 输入初始化验证码、创建 Passkey 并保存恢复码。验证码仅在初始化完成前存在。新安装无需 Windows LAN Token、网关密钥或管理员密码。操作完成后可按 [Cloud Direct](../../docs/cloud-direct.md) 连接电脑。

Compose 数据卷 `cloud-data` 保存 Cloud 数据；`caddy-data` 保存 HTTPS 证书与私钥，`caddy-config` 保存 Caddy 运行配置。不要删除这些卷。应用端口 `8765` 只绑定服务器回环地址；公网仅由 Caddy 提供 80/443。Windows `48211` 和路由器 SSH 不需要端口映射。

## 现有 Cloud 升级

先按 [迁移与备份说明](../../docs/migration-v1.md) 备份数据。

- 保留现有 `.env`，不要用示例覆盖。原来未配置 `LANPOWER_DATA_MOUNT` 时仍使用 `./data`，不会切换数据库。
- 若已有 HTTPS 代理占用 80/443，保留空的 `COMPOSE_PROFILES`，继续把代理指向 `127.0.0.1:8765`。不要同时启动第二个 Caddy。
- 原来使用 `./data` 的部署不要改为 `cloud-data`；否则会看到新的空数据库。修复方法是停止新服务、恢复原数据挂载，再启动，不要覆盖原始数据。
- 使用旧 Gateway 时继续叠加 `compose.legacy.yml`，命令见 [Cloud 部署说明](../../docs/cloud-deployment.md)。

## 检查与排障

```sh
docker compose ps
docker compose logs --tail 80 cloud caddy
curl -f http://127.0.0.1:8765/healthz
curl -f https://你的域名/healthz
```

证书申请需要实际域名和可达的 80/443。首次申请可能需要等待；确保 DNS 正确，不要在本机用示例域名申请证书。内置 Caddy 不启用访问日志，应用也不记录原始授权头或凭据。完整说明见 [Cloud 部署](../../docs/cloud-deployment.md) 与 [故障排查](../../docs/troubleshooting.md)。
