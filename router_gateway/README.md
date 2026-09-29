# AX3000T Router Gateway

本目录是 Xiaomi AX3000T / RD03（MediaTek MT7981、aarch64）的 LanPower Gateway。它只主动连接 Cloud，不在路由器上开放控制端口。WOL 已纳入 Go 程序；Windows 的 LAN Token 只存于 Windows 和路由器。

## Gateway v2

新版支持设备短码注册、独立凭据轮换、一个网关关联多台 Windows、远程唤醒和可选备用局域网控制。Windows 在线时，Cloud 优先直接控制 Windows。使用 `config.v2.example.json` 创建新版配置；完整注册、安装和迁移步骤见 [Wake Gateway v2](../docs/wake-gateway.md)。下文的共享密钥配置与 `seen.json` 为保留的 v1 兼容方式。

v2 凭据保存在配置同目录的 `device-credentials.json`，命令执行记录保存在 `command-receipts.json`，二者均为 `0600`。注册和常驻进程共用独占锁；重复命令返回原结果，执行中断后结果未知的命令不会重新执行。网关仅上传设备编号和能力/连通状态，不上传 Windows LAN Token、MAC 或广播地址。

## 构建

在装有 Go 1.22 或更新版本的电脑上，从本目录执行：

```powershell
$env:GOOS = 'linux'
$env:GOARCH = 'arm64'
$env:CGO_ENABLED = '0'
go build -trimpath -ldflags='-s -w' -o lanpower-gateway ./cmd/lanpower-gateway
```

配置由 `python -m cloud_remote.provision` 生成，详见 [Cloud 部署说明](../cloud_remote/README.md)。`gateway.json` 包含 LAN Token 和独立的 Gateway Secret，必须以 `0600` 权限保存在 `/data/lanpower/`，不要提交到 Git。PC IP 应先通过路由器 DHCP 静态绑定；示例地址只用于说明。

路由器 Shell 脚本必须保持 LF 换行，仓库通过 `.gitattributes` 固定该规则。从 Windows 导出已提交源码包时，在仓库根目录使用 `git -c core.autocrlf=false archive --format=tar -o "$env:TEMP\lanpower-source.tar" HEAD cloud_remote router_gateway`，避免用户级 `core.autocrlf=true` 使部署包出现 CRLF。Linux 报 `set: Illegal option` 或启动脚本解释器不存在时，先检查包内换行，再执行安装。

## 安装到路由器

通过已有的 LAN SSH 通道上传二进制、生成的配置、`scripts/install.sh` 与 `scripts/startup.sh` 至路由器临时目录。旧 Dropbear 可能需要 SSH 客户端显式启用 `ssh-rsa`；随后在路由器执行：

```sh
sh /tmp/install.sh /tmp/lanpower-gateway /tmp/gateway.json
```

安装脚本检查 aarch64、配置和进程健康；程序与持久化配置保存在 `/data/lanpower/`，运行时 PID 文件在 `/tmp/`，配置权限设为 `0600`。升级前先对候选二进制执行 `-check-config`，保留现行程序和 `startup.sh`；安装后确认 supervisor 与 Gateway 子进程持续运行。若启动或健康检查失败，安装脚本停止新进程，恢复旧二进制、startup 和 UCI include，再重启旧 Gateway，并输出 `upgrade failed and rolled back`。首次安装没有旧程序时会明确报告失败，不声称回滚成功。`gateway.json`、LAN Token 和 Gateway Secret 在回滚期间不会被覆盖或删除。UCI firewall include 保留实测必需的 `reload=1`。Gateway 自身用文件锁防重复实例，网络中断后自动重试。日志为 `gateway.log`，最大约 128 KB，加一个历史文件；重放记录在 `seen.json`。

## 可选 SSH 恢复

Gateway 自身通过 outbound HTTPS 工作，不依赖 SSH。新安装在 `/data/lanpower/maintenance.conf` 写入 `maintenance_ssh=false`，启动脚本不会为 Gateway 自动开启 Dropbear。确需保留 LAN SSH 救援通道时，在路由器本机显式设为 `maintenance_ssh=true`，并限制 SSH 只从可信 LAN 访问；不要把 SSH 开到 WAN。

升级已有 Gateway 时，如果旧 `startup.sh` 含有原先的 `nvram set ssh_en=1` 恢复逻辑且尚无 `maintenance.conf`，安装程序自动写入 `maintenance_ssh=true`，避免升级导致现有救援通道失效。确认无需 SSH 后，可自行改成 `maintenance_ssh=false`。安装程序不主动关闭已经运行的 SSH 服务，也不更改 WAN 防火墙规则。

运行检查：

```sh
/data/lanpower/lanpower-gateway -config /data/lanpower/gateway.json -check-config
cat /tmp/lanpower-gateway-child.pid
tail /data/lanpower/gateway.log
```

检查 Cloud 的 heartbeat 与状态接口可确认公网链路。安装脚本的进程健康检查不代替远端凭据或 HTTPS 联通检查。安装与升级模拟测试可在 Linux 从仓库根目录运行 `python -m unittest discover -s router_gateway/tests -v`。

## 卸载

```sh
sh /tmp/uninstall.sh
```

卸载脚本停止 Gateway，恢复安装前的 `startup.sh`（若存在）和对应 UCI include；生成的凭据及日志保留，便于恢复。原有 Windows 服务及数据不会被改动。

## 命令约束

Gateway 仅接受 `wake`、`status`、`sleep`、`hibernate`、`restart`、`shutdown`。每条命令包含网关 ID、UUID、nonce、签发与过期时间。重复 UUID、重复 nonce 和过期命令在执行前拒绝，并将已接收命令写入重放记录。Cloud 不接收 LAN Token，也不能向 Gateway 提供任意 URL、HTTP 方法或请求体。
