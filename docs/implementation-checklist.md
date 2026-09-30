# Cloud Direct 开发与验收清单

对应 `architecture-v2-cloud-direct.md` 的开发范围。2026-09-30：六个里程碑的核心源码和本地发布准备已实现；最终公网与硬件验收未完成，整个架构目标仍在进行。

## 六个里程碑

| 阶段 | 已实现 | 本地验证 | 尚待正式验收 |
|---|---|---|---|
| M1 Windows 产品化 | .NET 服务、WPF 桌面、命名管道、安装器、LAN 兼容；网络检测、Wi-Fi/离线安装、设置与更新检查 | Release 构建、48 项单元测试、6 项安装网络选择检查、服务/IPC 演练、实际 WPF 布局；目标 Windows 管理员首次安装、服务/LAN/IPC 与防火墙范围核验通过 | 保留配置升级、卸载重装、便携包安装、防火墙随地址变化、真实网络变化 |
| M2 Cloud Web 平台 | FastAPI、设备模型、七个网页入口、旧 Gateway 兼容、Docker/Caddy HTTPS、备份恢复 | 路由/迁移测试、桌面和手机浏览器流程、镜像与实际 Compose 本地 HTTPS、数据保留及恢复演练 | 公网域名、自动证书与正式环境恢复 |
| M3 Windows Cloud Direct | Windows 出站连接、状态上报、取命令、结果回传、直连优先、失效隔离、防重放 | 无网关的五动作模拟、API 往返、命令记录、刷新与连接管理检查 | **关闭网关，在公网 Web 对在线 Windows 执行 status、sleep、hibernate、restart、shutdown** |
| M4 统一身份 | Passkey、单管理员、恢复码、设备短码批准、独立会话、轮换与重用撤销、授权失败审计 | 真实签名与虚拟验证器、并发与失效边界；最新 Cloud 全部 83 项测试通过 | 真实 Windows Hello、Face ID、Touch ID 或安全密钥 |
| M5 小程序 v2 | 独立手机授权、电脑列表、逐电脑 LAN 配对、LAN First/Cloud Fallback、结果轮询、应用/协议版本上报 | 新旧 Node 测试、掉线缓存与不重复跨路径执行检查、版本校验与旧会话迁移 | 微信原生编译、扫码、存储、Wi-Fi/5G 切换 |
| M6 Gateway v2 | 短码注册、持久凭据、多电脑关联与唤醒、双方允许的备用控制、执行记录 | Go Linux 测试和静态检查、ARM64 构建、安装回滚模拟、Cloud 关联/队列隔离 | 多电脑 WOL、真实备用控制、硬件断网与重启恢复 |

本地自动检查不改变当前电脑电源状态；服务演练使用 `--dry-run`。已按用户授权清除旧 Windows 环境并安装新版，未备份旧数据；真实服务的只读访问检查通过，已安装程序哈希与构建产物一致。用户保留真实电源动作的手动验收。

## 跨阶段要求核对

| 要求范围 | 源码与文档位置 | 核对状态 |
|---|---|---|
| 三条路径、Windows 直连优先、显式 WOL、不自动先唤醒再关机 | `cloud_app/app/routing.py`、`platform.py`、Windows/Gateway 队列；`docs/cloud-direct.md` | 已实现并有路由与往返测试 |
| 动作枚举、目标/时间/随机值校验、防重复执行 | Windows Cloud 命令记录、Gateway `internal/protocol/`；`docs/security-model.md` | 已实现；真实物理结果仍待验收 |
| 账户归属、设备/客户端身份分离、短码批准、令牌哈希与单独撤销 | Cloud `models.py`、`identity.py`、`enrollment.py`、`device_auth.py`、`clients.py` | 已实现；拒绝、并发、过期、重放、隔离和撤销测试通过 |
| 登录、授权、撤销、命令路径、刷新轮换和凭据失败审计 | `audit.py` 及身份/路由服务、网页活动记录 | 已实现；已知凭据失败持久记录，重复失败合并，无秘密写入活动记录 |
| LAN 独立、Cloud 不保存 LAN 凭据、Cloud/Gateway 出站、不开放电脑公网端口 | Windows LAN/网络配置、Gateway 本地配置、Cloud 请求白名单；`docs/security-model.md` | 源码边界与模拟检查通过；部署网络由真实环境继续核验 |
| 升级与旧实现共存 | `source/`、`LanPower/`、`cloud_remote/`、`/api/v1/*`、小程序旧入口；`docs/migration-v1.md` | 保留；迁移只读旧数据，安装保留配置；管理员升级待验收 |
| 发布文件与校验清单、Cloud 镜像 | `scripts/build-release.ps1`、`verify-release.ps1`、`windows/installer/`；`docs/releasing.md` | 四个文件已生成并校验，解压服务演练通过；镜像本地构建通过 |
| CI、验证后发布、版本标签限制 | `.github/workflows/ci.yml`、`release.yml`、`scripts/validate-release-tag.py` | 本地工作流检查和标签拒绝检查通过；远程尚未运行，无 Run ID |
| 架构、部署、认证、迁移、故障文档与用户术语 | README、`docs/architecture-v2.md` 及文档入口 | 已更新；保留源码与实机验收的区别 |

## 本地提交记录

近期实现与收尾提交：

- `56a57f0`：Passkey、初始化与恢复码。
- `702867c`：设备批准与撤销。
- `8577fd1`：小程序 v2 与独立客户端授权。
- `5a9b7c4`：Gateway v2、多电脑和备用控制。
- `a0bfab1`：Cloud/桌面的网关状态和设备详情。
- `7c7d01c`：一键 HTTPS 与架构文档。
- `428b59c`：Windows 凭据恢复和连接管理。
- `1f63a31`：Windows 网络监控、安装和设置更新。
- `5a238df`：安装/便携发布产物与验证后发布流程。

早期 Windows 与 Cloud Direct 提交由仓库历史保留。本轮只在 `main` 本地提交，未推送、未正式发布。

## 实机验收安排

用户已指定本机 Windows 和云服务器，授权删除旧 LanPower 后全新部署，不备份旧环境。关机、重启、休眠、睡眠和唤醒由用户后续手动测试，本次自动工作只验证部署与只读状态链路。微信与网关验收还需相应手机、小程序开发环境和网关硬件。

Router Plugin、LAN 自动发现、多用户公开注册、其他操作系统设备、一次性逐客户端 LAN 授权为原文的后续扩展，本期保留现有 LAN 兼容接口。
