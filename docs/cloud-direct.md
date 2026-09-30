# Cloud Direct（源码版本 1.5.0）

LanPower Windows Service 在保留局域网接口的同时，主动通过 HTTPS 连接 Cloud。Cloud Web 面向浏览器提供设备列表和电源控制。没有 Wake Gateway 时，在线电脑仍可远程查看状态、睡眠、休眠、重启和关机；远程唤醒不可用。

## 连接 Windows

1. 部署 [Cloud Web](../cloud_app/README.md)，确认公网域名使用受信任的 HTTPS 证书。
2. 在 Windows 桌面应用的“远程控制”区域输入 Cloud 地址，点击“连接 Cloud”，查看设备短配对码。
3. 在 Cloud 网页登录，进入“连接电脑”或 `/enroll`，输入短码，核对名称后允许连接。配对十分钟内有效且只能兑换一次。Windows Service 保存独立设备凭据；Cloud 不接收局域网配对密钥。
4. 在 Cloud 总览确认新电脑在线；网页每 5 秒自动同步状态。按需使用开机、睡眠或“更多操作”中的电源按钮。

Cloud 不可用时，已配对的局域网客户端仍可调用 Windows LAN API。未配置 Cloud 也可只使用 LAN Direct。Windows 的 Cloud 连接仅使用出站 HTTPS，不需要路由器端口映射。

## 命令路径

| 条件 | 动作 | 路径 |
|---|---|---|
| Windows Cloud Agent 在线 | 状态、睡眠、休眠、重启、关机 | Cloud → Windows |
| Windows Agent 离线且关联 Wake Gateway 在线 | 开机 | Cloud → Gateway → WOL |
| Windows Agent 离线，v2 网关及电脑 LAN 在线，两端允许备用控制 | 状态及四种电源动作 | Cloud → Gateway → LAN |
| 旧版 Windows 与 Gateway 均在线 | 旧版电源动作 | Cloud → Gateway → LAN |
| 无可用路径 | 对应动作 | 返回不可用，不会自动开机 |

Cloud 将 Windows 心跳作为直连在线信号。网页按设备显示可用动作；在无网关模式下禁用开机按钮并说明未配置网关。设备页显示局域网地址、系统唤醒检测结果、网关和最近连接；Windows 桌面也能看到实际网关状态。命令只接受固定的电源动作，发往指定设备，带有失效时间和随机标识。本机在执行前持久记录命令标识，重复下发只回传既有结果，不会再次触发电源动作。

## 接口与凭据

- `POST /api/v2/enroll/start`、`POST /api/v2/enroll/token`：设备发起配对，等待网页批准并兑换独立凭据。
- `POST /api/v2/devices/token`：统一设备凭据轮换；`POST /api/v2/windows/token` 继续兼容 Windows。
- `POST /api/v2/devices/revoke`：设备使用自身 Access Token 移除自身，不能指定其他目标；浏览器和手机客户端不能调用该设备入口。
- `POST /api/v2/windows/enroll`：兼容旧版 Windows 的网页长配对码。
- `POST /api/v2/windows/heartbeat`、`GET /api/v2/windows/commands`、`POST /api/v2/windows/results`：Windows Agent 上报状态、领取命令与回执。
- `GET /api/v2/devices`、`GET /api/v2/devices/{id}`、`POST /api/v2/devices/{id}/commands`：Cloud Web 设备与控制接口。
- `GET /api/v2/commands/{id}`：查询命令回执。网页控制需要登录会话和 CSRF 校验。

设备 Access Token 有效期 15 分钟，Refresh Token 有效期 30 天并在使用时轮换；数据库仅保存摘要。旧刷新凭据再次出现会撤销该设备会话。Windows 将当前刷新凭据通过 DPAPI 加密保存在 `C:\ProgramData\LanPower\credentials.dat`，安装程序把数据目录限制为 SYSTEM 和管理员访问。Cloud 不保存 Windows 局域网凭据。

Windows 刷新前持久保存状态；响应丢失或进程中断后要求重新配对，不重发旧凭据。只在新响应写盘失败时重试本地保存。桌面断开 Cloud 时先停止当前连接并删除本机凭据，再尝试同步撤销原设备；Cloud 不可达时需在网页清理旧记录，LAN 继续工作。

## 验收边界

自动测试覆盖无网关配置下的入网、心跳、五种直连动作逐一选路、Windows 模拟领取、回执、刷新凭据重用以及 .NET Agent 的命令校验与重复执行保护。Windows 服务的局域网兼容测试在演练模式运行。真实公网 HTTPS、断开 Gateway 后逐项执行五种电源动作、睡眠后恢复、重启后自动连接，以及安装包升级，需要在可恢复的 Windows 设备上手动验收；测试脚本不会在当前工作电脑执行真实电源动作。
