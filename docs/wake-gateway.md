# Wake Gateway v2

Wake Gateway 是可选的常在线组件。在线 Windows 通过 Cloud Direct 控制；Windows 离线后，网关在局域网发送 WOL。一个网关最多配置 32 台电脑。新版源码和模拟测试已完成，指定路由器已注册 v2 并关联一台真实 Windows；物理 WOL、多电脑及备用控制仍待实机验收，新版尚未正式发布。

## 使用前准备

- 已部署 HTTPS Cloud，并将 Windows 注册到 Cloud。
- 路由器为 Linux ARM64，当前安装脚本适配 AX3000T / RD03。
- 电脑支持 WOL，并已在固件和网卡中配置。网关发送成功只表示发出唤醒包，不能保证电脑已经开机。
- 通过可信局域网管理路由器；不开放路由器 WAN SSH 或 Windows `48211` 公网入口。

## 新安装

1. 按 [网关构建说明](../router_gateway/README.md) 构建 Linux ARM64 二进制。将二进制及 LF 换行的 `install.sh`、`startup.sh` 上传到路由器 `/tmp/`。
2. 复制 [v2 示例](../router_gateway/config.v2.example.json) 为私有 `gateway.json`，填写自己的 Cloud HTTPS 根地址和网关名称。在 Cloud“我的设备”中展开“配置唤醒网关”，获取电脑编号；将其填入 `devices[].device_id`，并填写该电脑 MAC 和局域网广播地址。仅做唤醒时保持 `backup_relay: false`。
3. 将配置上传到路由器 `/tmp/gateway.json`，在**尚未安装旧网关的新环境**执行：

```sh
mkdir -p /data/lanpower
chmod 700 /data/lanpower
cp /tmp/gateway.json /data/lanpower/gateway.json
chmod 600 /data/lanpower/gateway.json
chmod 700 /tmp/lanpower-gateway
/tmp/lanpower-gateway -config /data/lanpower/gateway.json -check-config
/tmp/lanpower-gateway enroll -config /data/lanpower/gateway.json
```

4. 保持注册进程运行，在浏览器登录其显示的 Cloud `/enroll` 页面，输入短码，核对名称与设备类型后允许连接。短码不能兑换凭据，完整设备码只在网关与 Cloud 间交换。注册成功后凭据存到 `/data/lanpower/device-credentials.json`。
5. 注册成功后安装并启动：

```sh
sh /tmp/install.sh /tmp/lanpower-gateway /data/lanpower/gateway.json
```

6. 在 Cloud“唤醒网关”页面，为该网关逐台关联电脑。等待状态变为在线，目标电脑的“开机”按钮才可用。Cloud 关联和网关本地 `devices` 配置必须匹配。

无电脑配置的 `devices: []` 也可以先注册网关；配置电脑后需重启网关进程。安装脚本会保留已有 `gateway.json`，不会因为上传新的示例而自动替换它。

## 可选备用控制

每台需要备用控制的电脑，在其本地网关条目增加：

```json
{
  "device_id": "该电脑在 Cloud 的编号",
  "mac": "02-11-22-33-44-55",
  "broadcast": "192.168.1.255",
  "pc_ip": "192.168.1.10",
  "port": 48211,
  "lan_token": "该电脑的局域网凭据，仅保存在网关本地",
  "backup_relay": true
}
```

以上为字段说明，需替换设备编号、地址和凭据才能通过检查。然后在 Cloud 对这台电脑勾选“允许备用控制”并保存。局域网凭据必须来自该电脑本地配对，不能使用 Cloud 设备凭据代替。Cloud 网页不接收或显示 LAN Token。

| 电脑云端连接 | 网关与 LAN 状态 | 动作 | 路径 |
|---|---|---|---|
| 在线 | 任意 | 状态、睡眠、休眠、重启、关机 | Cloud Direct |
| 离线 | 网关在线，目标允许唤醒 | 开机 | Wake Gateway |
| 离线 | 网关在线、电脑 LAN 在线、两端均允许备用控制 | 状态及四种电源操作 | Backup Relay |
| 离线 | 路径不满足条件 | 任意 | 明确不可用 |

状态查询失败不会自动开机。已发出但结果未知的电源请求不会切到其他路径重复执行。

## 升级与旧版迁移

普通二进制升级继续使用 [现有安装与回滚流程](../router_gateway/README.md)。保留 `gateway.json`、`device-credentials.json` 和 `command-receipts.json`；安装程序不会覆盖或删除它们。v1 配置没有 `protocol_version` 时继续走旧协议，无需立即迁移。

从 v1 切换至 v2 需要主动更换配置：先保存旧二进制、配置、启动脚本和日志；使用现有 `uninstall.sh` 停止 Gateway 并移除自动启动（私有数据会保留），再将新的 v2 配置放到 `/data/lanpower/gateway.json`。使用新版二进制完成上述注册与安装，并在 Cloud 关联已注册的 Windows。切换失败时，用备份的 v1 配置与二进制重新安装。不要仅覆盖正在运行的配置或删除旧 Cloud 配置；其他旧小程序/网关可能仍在使用它。

## 凭据和命令

- 网关 Access Token 为 15 分钟，Refresh Token 为 30 天，自动轮换；Cloud 数据库只保存哈希。
- 凭据文件权限 `0600`，目录建议 `0700`。凭据绑定 Cloud 地址，改地址需要重新注册。
- 刷新前先保存待完成标记。刷新响应丢失或此时进程退出后，要求重新注册，避免重用已经消耗的 Refresh Token。重新注册前停止常驻程序，在 Cloud 移除旧网关，并在新网关上重新建立关联。
- 注册成功但本地磁盘写入失败时，仅重试保存，不再次兑换一次性凭据；终止前应修复磁盘空间或目录权限。
- 网关只接受 `wake/status/sleep/hibernate/restart/shutdown`。每条命令检查网关、电脑白名单、动作、编号、随机数和有效期；Cloud 不能下发任意地址、Shell 或脚本。
- 动作执行前持久保存接收记录，完成后保存结果。重试返回原结果；进程中断导致结果未知时不重复执行。记录损坏或无法保存时拒绝执行。
- Cloud 移除设备、解除或修改关联会取消未完成命令；已送达网关的动作可能已经执行，无法撤回。移除一台电脑不会让网关上的其他电脑掉线。
- 心跳约每 25 秒发送，仅含设备编号、版本、运行时间和逐台可达/唤醒/备用控制状态。LAN Token、MAC、广播地址均保留在网关本地。

## 本地验证（2026-09-30）

- 网关阶段的 Cloud 63 项测试通过，其中 14 项覆盖新版网关多电脑、直连优先、备用控制条件、跨账户隔离、撤销、命令领取和结果幂等；完整平台最新 83 项测试通过。
- Go 配置、TLS 模拟注册、并发刷新、刷新响应丢失、磁盘失败、禁止重定向、防重复执行和多个目标的测试通过。使用 Windows Go SDK 编译 Linux 测试程序后在 Ubuntu WSL 中执行；未触发真实 WOL 或电源动作。
- `go vet`、Linux ARM64 静态二进制构建通过。
- Linux 安装/升级/回滚 6 项模拟测试通过；从 Git 导出 LF 脚本，避免 Windows 工作区换行干扰。
- Playwright 验证注册后网页关联两台电脑、备用控制选择、解除关联，以及 1280×900 / 390×844 布局。
- CI 已包含 Cloud、Go、安装脚本和 ARM64 构建；本轮未推送，远程 CI 无 Run ID。

## 指定路由器验证（2026-09-30）

通过现有局域网 SSH 管理通道，将真实 ARM64 路由器上的 v1 网关迁移为 `2.0.0` / 协议 `2`。实际程序版本、配置检查和上传校验通过；路由器可访问正式公网 HTTPS Cloud。注册由网关发起，经真实网页登录核对短码与网关名称后批准，凭据由网关兑换并持久保存，配置与凭据均为 `0600`。

Cloud 网页已关联一台真实 Windows，网关在线且电脑 `wake_available: true`，Windows 桌面同步显示远程唤醒可用。配置为唤醒模式，未保存 Windows LAN Token，备用控制默认关闭。网关在线时，网页只读 `status` 仍走 `windows_direct` 并返回 `completed`；桌面和手机宽度下的关联与状态页面检查通过。

终止实际网关子进程后，监督程序自动创建新进程，原网关凭据保留；随后真实 Access/Refresh 自动轮换成功，新会话继续上报状态。UCI 自动启动 include 保持 `enabled=1`、`reload=1`。旧网关辅助程序、过期的 v1 配置和部署临时目录已清理。

上述检查验证程序恢复和凭据轮换，路由器整机重启和断网恢复仍未验收。自动工作未发送 WOL 或电源命令；实际唤醒、多电脑和备用控制由后续硬件验收确认。设备反馈的“已送达/正在切换”不能替代物理电源状态验证。
