# CodexDock 项目名称与定位

项目名称为 **CodexDock**，原名称为 **LanPower**。本项目以 Codex 远程开发与会话控制为主，附带电脑电源管理；当前 Windows / Cloud / Web 源码版本为 `1.24.9`，微信小程序为 `3.6.14`，配套 Wake Gateway 为 `2.1.2`。

## 主功能与配套功能

主功能是通过网页或微信小程序连接自己的 Windows 电脑，使用当前用户的原 Codex 窗口与原服务：读取项目与完整聊天历史，发送、继续、引导和暂停任务，处理原生队列与审批，查看工作过程、文件、图片与能力状态。支持范围以 [功能对齐](codex-system-parity.md)、[使用指南](codex-remote.md) 与各轮验收记录为准。

电源管理提供电脑状态、睡眠、休眠、重启、关机及 WOL 唤醒，为远程开发电脑提供配套支持。Wake Gateway 是可选唤醒组件；在线电脑的 Codex 开发链路不依赖网关。电脑唤醒后仍需满足 Windows 用户登录、Codex 登录和项目授权要求。

## 名称使用约定

| 使用位置 | 名称 |
|---|---|
| README、当前说明文档与产品介绍 | CodexDock |
| Windows 窗口、托盘、安装器与快捷方式 | CodexDock |
| Windows 后台服务的显示名称 | CodexDock Service |
| Cloud 控制台与 API 显示名称 | CodexDock Cloud |
| Web / PWA 页面与微信小程序 | CodexDock |
| Python 分发包与新命令入口 | `codexdock-cloud` |
| Web 工程包 | `codexdock-web` |
| 本机新版本 Docker 镜像 | `codexdock-cloud:1.24.9-dev.1` |

后续功能介绍、需求安排与验收优先围绕 CodexDock；电源控制和网关文档明确标记为配套或兼容内容。历史版本记录、旧版附件和原有技术标识按实际情况保留，避免把旧记录误写成当前验收结果。

## 就地升级与兼容标识

产品更名沿用已有身份、安装和配置。以下标识保留，既有安装可直接升级，无需重新配对或另建数据库：

- Windows 的 `LanPowerService` 服务名、程序集、命名空间、命名管道、登录任务与防火墙标识；仅调整面向用户的名称和服务描述。
- 已有安装目录、`%ProgramData%\LanPower` 和 `%LOCALAPPDATA%\LanPower`。项目文件夹 `D:\GitHub\LanPower` 也继续沿用。
- Cloud 的 `LANPOWER_*` 配置键、数据库目录、API 路径、Cookie / 存储键，以及现有 `lanpower-dev` Compose 项目、数据卷和证书。
- 小程序的 AppID、既有授权与分环境缓存键；源码中的 `projectname` 和标题使用新名称。微信平台的已登记名称由平台管理，本机源码修改不会改变它。
- `lanpower-cloud` 命令保留为兼容入口，新增 `codexdock-cloud` 指向相同维护程序。
- 现有安装包、便携包和网关文件名继续兼容已有构建、校验和更新流程；公开仓库地址、远程配置、历史标签和旧下载链接沿用原地址。

公开仓库改名、发布资源更新与远程 Cloud 部署在明确要求同步或部署时执行。本次名称调整的本机验证与更新结果见 [本机开发环境](local-development.md)。
