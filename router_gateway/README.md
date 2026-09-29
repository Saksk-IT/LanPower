# AX3000T Router Gateway

本目录是 Xiaomi AX3000T / RD03（MediaTek MT7981、aarch64）的 LanPower Gateway。它只主动连接 Cloud，不在路由器上开放控制端口。WOL 已纳入 Go 程序；Windows 的 LAN Token 只存于 Windows 和路由器。

## 构建

在装有 Go 1.22 或更新版本的电脑上，从本目录执行：

```powershell
$env:GOOS = 'linux'
$env:GOARCH = 'arm64'
$env:CGO_ENABLED = '0'
go build -trimpath -ldflags='-s -w' -o lanpower-gateway ./cmd/lanpower-gateway
```

配置由 `python -m cloud_remote.provision` 生成，详见 [Cloud 部署说明](../cloud_remote/README.md)。`gateway.json` 包含 LAN Token 和独立的 Gateway Secret，必须以 `0600` 权限保存在 `/data/lanpower/`，不要提交到 Git。PC IP 应先通过路由器 DHCP 静态绑定；示例地址只用于说明。

## 安装到路由器

通过已有的 LAN SSH 通道上传二进制、生成的配置、`scripts/install.sh` 与 `scripts/startup.sh` 至路由器临时目录。旧 Dropbear 可能需要 SSH 客户端显式启用 `ssh-rsa`；随后在路由器执行：

```sh
sh /tmp/install.sh /tmp/lanpower-gateway /tmp/gateway.json
```

安装脚本检查 aarch64、配置和进程健康；文件只进入 `/data/lanpower/`，配置权限设为 `0600`。它保存原有 `startup.sh`，然后设置 UCI firewall include，包含实测必需的 `reload=1`。正式版 `startup.sh` 恢复原有 LAN SSH 启动行为，并监护 Gateway 进程。Gateway 自身用文件锁防重复实例，网络中断后自动重试。日志为 `gateway.log`，最大约 128 KB，加一个历史文件；重放记录在 `seen.json`。

运行检查：

```sh
/data/lanpower/lanpower-gateway -config /data/lanpower/gateway.json -check-config
cat /tmp/lanpower-gateway-child.pid
tail /data/lanpower/gateway.log
```

检查 Cloud 的 heartbeat 与状态接口可确认公网链路。安装脚本的进程健康检查不代替远端凭据或 HTTPS 联通检查。

## 卸载

```sh
sh /tmp/uninstall.sh
```

卸载脚本停止 Gateway，恢复安装前的 `startup.sh`（若存在）和对应 UCI include；生成的凭据及日志保留，便于恢复。原有 Windows 服务及数据不会被改动。

## 命令约束

Gateway 仅接受 `wake`、`status`、`sleep`、`hibernate`、`restart`、`shutdown`。每条命令包含网关 ID、UUID、nonce、签发与过期时间。重复 UUID、重复 nonce 和过期命令在执行前拒绝，并将已接收命令写入重放记录。Cloud 不接收 LAN Token，也不能向 Gateway 提供任意 URL、HTTP 方法或请求体。
