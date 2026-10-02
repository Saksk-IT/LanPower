# Codex Remote MVP 执行结果与后续验收

日期：2026-10-02。当前源码为 LanPower Windows / Cloud / 安装器 **1.10.0**，小程序 **2.0.6**，Wake Gateway **2.1.2**。1.9 新增自动项目发现、跨项目最近会话、手机列表/详情、消息格式展示、原生引导与暂停；桌面占用会话同步查看，跨 Runtime 接管仍未实现。第一阶段 MVP 已实现并在本机验证；正式 Cloud 仍为 1.7.2，公开 Release 仍为 v1.6.1。本轮不授权远程部署或发布。

## 已完成的第一阶段

- [x] 采用 Windows Agent + Cloud Relay + Web/PWA，Windows 只主动出站 HTTPS/WSS。
- [x] 保留 LAN Direct、Cloud Direct、Wake Gateway、小程序、电源、配对与既有数据库格式。
- [x] 对接官方 `codex app-server --listen stdio://`，使用已登录 Windows 用户的 Codex 环境；Service 不以 SYSTEM 运行 Codex。
- [x] 用户 Host 安装与登录启动、本地默认关闭授权、项目选择、受保护的管道和进程生命周期。
- [x] Cloud 类型/所有权/同源认证、撤销、内存路由、限额背压和不含正文的审计。
- [x] 浏览器创建/列出/恢复本机会话，提交中文任务，实时 AI/工具输出，单次审批，Diff，中断和断线状态恢复。
- [x] 项目路径、方法及参数白名单，多层阻止远端登录、配置写入、Shell RPC、任意文件 RPC 和安全策略覆盖。
- [x] 版本与打包规则更新，排除 Codex Home/登录文件/运行时配置，保留升级与卸载数据。
- [x] Cloud、Windows、浏览器和既有小程序/电源链路回归；本机 Docker 与 Windows 更新。
- [x] 使用当前用户真实登录的 Codex，经实际 Service WSS Agent、用户 Host 管道与浏览器执行独立测试文件修改，文件审批、输出、Diff 和刷新恢复通过。

代码入口：[Cloud Relay](../cloud_app/app/remote.py)、[WSS Agent](../windows/LanPower.Service/CodexRemoteAgent.cs)、[管道桥接](../windows/LanPower.Service/CodexHostBridge.cs)、[用户 Host](../windows/LanPower.CodexHost/)、[Web/PWA](../cloud_app/static/remote.js)。完整使用与证据见 [Codex Remote](codex-remote.md)，准确的协议见 [Relay v1](codex-remote-protocol.md)。

## 根据实现确定的范围

原计划中的建议字段与限额由实际协议文档替代：外层采用 `hello/open/close/state/rpc/ping/pong`，不采用 `runtime_request/runtime_message`；每设备一个控制页面，Relay 队列最多 32 帧/8 MiB，避免多控制端的审批竞争。

`initialize/initialized` 和账户读取在 Host 内部完成，网页仅取得登录布尔值。1.9 支持引导本 Runtime 的当前任务，并校验 `expectedTurnId`；桌面独立 Runtime 的已运行任务不能接管。浏览器不能远端登录、改配置、装插件或调用任意 Shell/文件接口；账号限额、完整历史分页、多控制端和手机专用 scoped token 留待后续。网络审批最多当前 turn，文件系统额外权限/MCP 交互授权保留本机处理。

本机 CLI 0.159.0 的 Schema 生成、stdio 初始化和 Thread 创建/列表已验证。空 Thread 首次任务前不保证持久化，因此 Host 暂存新空会话，重启前未发送任务的会话不恢复。部分工作目录只发 `fileChange` item Diff 而不发汇总通知，Host 和网页均支持由文件事件恢复 Diff。

TLS 在 Cloud 终止，当前未实现端到端加密；Cloud 运维必须可信，禁止正文日志、采样或转储。Cloud 不保存 OpenAI API Key、ChatGPT 凭据、任务或代码。单 worker/单副本是部署前提，多副本路由尚未实现。

## 下一步人工验收

- [ ] 用户在本机 Windows 启用授权、添加真实项目并确认使用体验。
- [ ] 用户明确要求后，备份并部署正式 Cloud 1.10.0；本轮不修改正式云端。
- [ ] 手机 5G/异地浏览器：登录、查看 Windows 状态、实际唤醒、等待用户会话、连接 Codex并完成可审查任务。
- [ ] 真实命令审批拒绝/批准、中断中的部分修改、断网/切网与长任务。
- [ ] 撤销设备/浏览器登录与本地关闭授权后，无法继续提交任务或审批。
- [ ] Windows 注销/重新登录、重启后的 Host 恢复；无用户登录时仅显示不可用。
- [ ] 正式部署的代理长连接、较大输出、备份恢复与同版本回滚。

本机真实 AI 文件修改通过，不代表手机 5G、物理唤醒和正式公网部署已通过。正式 Release 应在用户完成上述验收并要求同步后另行发布。

## 参考

- [OpenAI 官方 app-server 文档](https://developers.openai.com/codex/app-server)
- [OpenAI app-server 源码和协议说明](https://github.com/openai/codex/tree/main/codex-rs/app-server)
- [LanPower 安全边界](security-model.md)、[架构](architecture-v2.md)、[构建与发布](releasing.md)
