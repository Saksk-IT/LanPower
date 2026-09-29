# LanPower Remote Cloud

Cloud 是单家庭预览版的 HTTPS 命令中继：保存网关与手机各自的独立凭据、命令结果和心跳状态；不保存 Windows LAN Token。服务使用 Python 标准库、SQLite，并且只监听 `127.0.0.1:8765`，公网 HTTPS 由同机反向代理提供。现有 Windows `48211` 和路由器 SSH 均不应对公网开放。

## 生成私有配置

在能读取 Windows `C:\ProgramData\LanPower\config.json` 的受信电脑上，从仓库根目录执行：

```powershell
python -m pip install qrcode==8.2
python -m cloud_remote.provision --cloud-url https://power.example.com `
  --lan-config C:\ProgramData\LanPower\config.json `
  --mac 02-11-22-33-44-55 --broadcast 192.168.1.255
```

把 `power.example.com` 换成实际 HTTPS 域名。生成文件在忽略提交的 `private/` 中：

| 文件 | 安装位置 |
| --- | --- |
| `cloud.json` | 云服务器，文件权限 `0600` |
| `gateway.json` | 路由器 `/data/lanpower/gateway.json`，权限 `0600` |
| `remote-pairing.svg` | 仅供本人在小程序扫描，扫描后妥善保存或删除 |

云端和路由器仅共享 `gateway_secret`。手机与云端共享另一组 `client_secret`；它只进入配对二维码，不应发给路由器。Windows 的 LAN Token 只进入路由器配置。已存在的 `private/` 不会被覆盖，以免误换凭据。

## 部署

将 `cloud_remote/` 源码与 `cloud.json` 放到云服务器，配置中的 `database` 指向可写的持久化目录。安装 Python 3.12 或更高版本后运行：

```sh
chmod 600 /opt/lanpower/cloud.json
python3 -m cloud_remote.server --config /opt/lanpower/cloud.json
```

从仓库根目录运行模块，或把仓库根目录加入 `PYTHONPATH`。使用 systemd 等服务管理器保持进程运行，并对 SQLite 数据库做备份。反向代理示例（Caddy）：

```caddyfile
power.example.com {
    reverse_proxy 127.0.0.1:8765
}
```

只公开反向代理的 HTTPS 入口；Cloud 进程始终绑定 loopback。`GET /healthz` 返回服务进程状态，不代表 Gateway 在线。`GET /api/v1/client/status?gateway_id=home-router` 使用手机 Bearer 凭据，区分 Gateway 在线、PC 在线与 PC 离线。路由器每轮长轮询前上报心跳，最多等待 25 秒取命令。命令一次投递，最长有效期 45 秒；Cloud 重启或网关掉线时，未完成的客户端请求会超时，而不会重发可能已经执行的电源动作。

小程序还需在微信平台配置实际 HTTPS 域名，再用真机分别验证 Wi-Fi 和 5G。当前仓库没有实际域名、云服务器配置或私有凭据，故远程链路尚未做该环境下的端到端实测。
