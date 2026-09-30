# 迁移与数据保留

迁移按组件逐步进行。旧 Windows Python、`Install.cmd`、旧小程序入口和 `/api/v1/*` 保留；无需同时更换所有组件。下列操作在自己的部署环境执行，仓库测试数据库不可用于覆盖服务器。

## 备份 Cloud

保留 `.env`、私有 `cloud.json`、平台数据库和旧 `relay.db`。Caddy 数据卷含证书私钥，也需纳入私有备份。备份文件应只允许部署管理员访问。

SQLite 可以使用在线备份 API 获取一致副本。在 `deploy/docker/` 执行以下命令，在数据卷中创建一个新的带时间戳备份目录：

```sh
docker compose exec -T cloud python - <<'PY'
from contextlib import closing
from pathlib import Path
import sqlite3
import time

root = Path("/var/lib/lanpower-cloud")
target = root / "backups" / time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
target.mkdir(parents=True, exist_ok=False, mode=0o700)
for source in (root / "platform.db", root / "relay.db"):
    if source.exists():
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as original:
            with closing(sqlite3.connect(target / source.name)) as backup:
                original.backup(backup)
print(target)
PY
```

再用 `docker compose cp cloud:/var/lib/lanpower-cloud/backups ./backups` 将副本复制到主机安全目录，检查生成的文件并计算校验和。备份命令失败时不要继续更新。`.env`、旧配置与证书应另行保存；数据库备份不包含这些文件。

恢复前先停止 Cloud，另存当前数据库，再将确认过的备份恢复至同一挂载中。不要把较旧平台程序直接指向已经升级的数据库；应按备份对应的版本和数据一起恢复。恢复后轮换凭据可能已变化，必要时重新注册设备和客户端。

## 旧 Cloud 升级

1. 保留原 `cloud.json` 与 `relay.db`，记录正在运行的版本和数据路径。
2. 新平台使用独立 `platform.db`，不得指向原 `relay.db`。启用 `compose.legacy.yml` 后，旧数据路径仍需指向原文件。
3. 可先只读核验并登记 Legacy 资源：

```sh
docker compose -f compose.yml -f compose.legacy.yml run --rm cloud lanpower-cloud migrate-v1
```

命令只读检查原 `relay.db`，重复执行不会重复登记设备；`python -m cloud_app.cli migrate-v1` 继续兼容。新 Cloud 接管 `/api/v1` 前停止旧 Cloud，避免两个服务同时使用旧中继数据库。

4. 检查旧网关、旧手机和新浏览器是否可查询状态，然后再迁移其他组件。

## Windows 与小程序

新安装器保留已有 64 位 LAN 配对密钥，新服务健康后才移除旧开机任务。卸载新应用保留 ProgramData。安装/升级实机验收仍需在可恢复电脑进行；先备份配置并保留原安装包。

小程序保留旧存储与“仅使用局域网 / 旧版连接”入口。新 Cloud 授权与原 LAN 配对分开，手机可先保留旧方式，再逐台关联新电脑。

## 网关

新版二进制可继续读取原 v1 配置。主动切换 v2 时，先备份并停止旧网关，再注册独立设备凭据；参考 [Wake Gateway 迁移](wake-gateway.md)。Cloud 中新的 Windows 编号与原 Legacy Windows 不相同，应核对关联目标。
