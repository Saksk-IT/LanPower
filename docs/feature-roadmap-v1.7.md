# LanPower v1.7 功能需求文档

> 基于 v1.6.1 代码库，描述 v1.7.0 新增和升级的功能需求。
> 文档供 AI 编码代理执行，只描述需求和约束，不规定实现方式。

---

## 总体原则

- 不破坏任何现有接口和功能，新增为扩展，改造为向后兼容增量。
- 所有新增数据库表或字段，需提供对应的 Alembic 迁移脚本。
- 所有新增页面继承现有 `base.html` 模板，沿用现有样式系统。
- 新增审计事件 key 追加到 `main.py` 的 `EVENT_LABELS` 字典，使用中文标签。
- 完成全部任务后，整体版本号升级为 **1.7.0**。

---

## 任务 1：SQLite WAL 模式优化

**文件**：`cloud_app/app/database.py`

### 需求
在 SQLite 数据库连接建立时，自动开启 WAL 日志模式和相关性能参数，减少读写锁竞争。

### 具体要求
- 仅对 SQLite 类型的数据库 URL 应用此配置，其他数据库类型（如 PostgreSQL）跳过。
- 需要启用的 SQLite PRAGMA：`journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=10000`。
- 确保多线程并发访问不报 "check_same_thread" 错误。
- 现有测试套件不应因此配置产生新的失败。

---

## 任务 2：操作历史页面增强

**文件**：`cloud_app/app/main.py`、`cloud_app/templates/activity.html`

### 需求
`/activity` 页面已存在但内容简单，需要增强为可筛选、可分页的完整操作历史视图。

### 具体要求
- 每条历史记录展示：绝对时间（精确到分钟）、相对时间、事件类型（中文标签）、目标设备名称（无设备则显示"–"）。
- 支持按事件类型筛选，通过 URL 查询参数 `event` 传递，页面顶部提供下拉选择器。
- 分页显示，每页 50 条，底部显示当前页码和总页数，提供上一页/下一页控件。
- 设备名称通过关联查询 `devices` 表获得，不能仅展示 device_id。
- 新增一个 Jinja2 filter，将 Unix 时间戳格式化为 `YYYY-MM-DD HH:MM` 的绝对时间字符串，注册到模板环境。

---

## 任务 3：设备状态 Server-Sent Events 实时推送

**文件**：`cloud_app/app/main.py`、`cloud_app/static/`（新建 JS 文件）、`cloud_app/templates/dashboard.html`

### 需求
Web 控制台中设备的在线/离线状态和最后活跃时间，无需手动刷新页面即可实时更新。

### 后端需求
- 新增一个 SSE 端点，路径建议为 `/api/v2/events/devices`，需登录鉴权。
- 每 5 秒检测一次设备状态变化，仅在状态发生变化时推送，无变化时发送 keep-alive 注释。
- 客户端断开连接时，服务端应停止生成器，不产生资源泄漏。
- 响应头需包含 `X-Accel-Buffering: no` 以兼容 nginx 反向代理。

### 前端需求
- 新建一个独立的静态 JS 文件处理 SSE 逻辑，不在模板内内联大段脚本。
- 收到推送数据后，通过 DOM 操作更新对应设备行的状态点颜色和"最后活跃"文字，不重新加载页面。
- 每个设备行/卡片需要有可供 JS 定位的 `data-device-id` 属性。
- 状态点用 CSS class 区分在线（绿色）/离线（灰色），支持平滑过渡。
- 连接错误时静默重连（依赖浏览器 EventSource 自动重试机制即可），不向用户展示错误弹窗。

---

## 任务 4：计划任务（定时电源操作）

**文件**：`cloud_app/app/models.py`、新建 `cloud_app/app/scheduled.py`、`cloud_app/app/main.py`、新建 `cloud_app/templates/schedules.html`、Alembic 迁移

### 需求
用户可以为指定设备设置定时执行的电源操作，例如每天 22:00 自动睡眠，工作日 8:30 自动唤醒。

### 数据模型
新增 `scheduled_tasks` 表，字段需包含：
- 关联用户（owner_id）和目标设备（device_id）
- 操作类型（sleep / hibernate / restart / shutdown / wake）
- 执行时间规则：小时（0–23）、分钟（0–59）、星期（0–6 对应周日到周六，-1 表示每天）
- 启用/禁用开关
- 可选备注标签
- 创建时间、上次执行时间、下次执行时间

### 调度器需求
- 独立后台线程，应用启动时自动启动，应用关闭时优雅停止。
- 每 60 秒扫描一次到期任务并执行，执行后更新上次/下次执行时间。
- 执行失败时记录日志，不影响其他任务继续运行。
- 下次执行时间在任务创建和每次执行后重新计算，基于当前时间和 cron 规则向前推算。

### 管理接口需求
- `GET /schedules`：列出当前用户所有计划任务，渲染 `schedules.html`。
- `POST /schedules`：创建新任务，参数包括 device_id、action、minute、hour、weekday、label。
- `POST /schedules/{id}/toggle`：切换任务的启用/禁用状态。
- `POST /schedules/{id}/delete`：删除任务。
- 创建时校验：device_id 必须属于当前用户；action 必须合法；时间参数必须在合法范围内。

### 页面需求
- `schedules.html` 继承 `base.html`，展示任务列表（设备名、操作、执行时间的人类可读描述、下次执行时间、启用状态）和新建表单。
- 新建表单：下拉选择设备、下拉选择操作、时/分数字输入、星期选择（包含"每天"选项）、备注输入框。
- 导航栏追加"计划任务"入口，链接到 `/schedules`。
- 新增审计事件：`schedule_created`（创建计划任务）、`schedule_deleted`（删除计划任务）、`schedule_fired`（计划任务已执行）。

---

## 任务 5：WOL 唤醒结果反馈

**文件**：`cloud_app/app/main.py`、`cloud_app/templates/dashboard.html`、`cloud_app/static/`

### 需求
用户点击"唤醒"按钮后，界面提供明确的反馈：设备是否成功上线，而不是点击后毫无响应。

### 后端需求
- 新增一个轻量查询端点，仅返回指定设备当前是否在线及最后状态，浏览器和移动客户端均可访问。
- 路径建议：`GET /api/v2/devices/{device_id}/online`，返回 `online`（布尔）、`last_seen`（时间戳）、`state`（字符串）。

### 前端需求
唤醒按钮点击后的完整交互流程：
1. 按钮立即变为"唤醒中…"状态并禁用，防止重复点击。
2. 发送唤醒命令到现有的 `POST /api/v2/devices/{id}/commands` 接口。
3. 命令发出后，每 5 秒轮询上述在线状态端点，最多持续 120 秒（24 次）。
4. 设备上线时，显示"唤醒成功"提示（绿色），3 秒后恢复按钮为可用状态。
5. 120 秒超时后仍未上线，显示"设备未响应，请检查 BIOS 是否开启 Wake-on-LAN"提示（橙色），恢复按钮。
6. 提示信息显示在按钮附近，不使用全屏弹窗。

---

## 任务 6：设备分组与批量操作

**文件**：`cloud_app/app/main.py`、`cloud_app/templates/dashboard.html`

### 需求
当设备数量增多时，支持用户对设备按自定义分组标签组织，并支持对多台设备同时执行操作。

### 分组功能
- 分组标签存储在 `Device.meta["group"]` JSON 字段中，无需新建数据库表。
- 新增接口：`POST /api/v2/devices/{device_id}/group`，请求体含 `group` 字段（空字符串表示移除分组），需登录鉴权。
- 记录审计事件 `device_grouped`（修改设备分组）。
- `dashboard.html` 中设备按分组聚合展示，同组设备渲染在同一区块下，未设置分组的设备归入"未分组"。
- 设备名称旁提供分组标签的内联编辑入口（例如铅笔图标），编辑完成后通过上述接口提交，不刷新整页。

### 批量操作功能
- 新增接口：`POST /api/v2/devices/batch-command`，请求体含 `device_ids`（数组）和 `action`，单次最多 20 台。
- 校验每个 device_id 属于当前用户，逐台执行命令，返回每台设备的成功/失败结果。
- `dashboard.html` 中每台设备左侧提供复选框，顶部有"全选/取消全选"和批量操作下拉菜单（睡眠/关机/重启），点击"执行"时调用批量接口，完成后展示各设备执行结果。

---

## 任务 7：手机客户端细粒度权限控制

**文件**：`cloud_app/app/models.py`、`cloud_app/app/clients.py`、`cloud_app/app/main.py`、`cloud_app/templates/clients.html`、Alembic 迁移

### 需求
为手机客户端授权增加权限范围控制，管理员可以限制某个客户端只能执行特定操作，例如"仅允许睡眠，不允许关机"。

### 数据模型
`ClientSession` 表新增 `allowed_actions` 字段，存储逗号分隔的允许操作列表（如 `sleep,hibernate,wake,status`）。空字符串表示不限制（兼容旧数据，全权限）。

### 权限校验
- 移动客户端调用 `POST /api/v2/devices/{device_id}/commands` 时，云端校验请求的 action 是否在该客户端的 `allowed_actions` 范围内。
- 不在范围内时返回 HTTP 403，错误信息说明具体受限的操作名称。
- 浏览器 Web 会话调用此接口时不受限（浏览器登录即全权限）。

### 授权创建界面
`clients.html` 中生成客户端二维码的表单新增权限范围选择区域，以复选框形式呈现所有可用操作（查看状态、睡眠、休眠、重启、关机、唤醒），默认全选，提交时将选中项写入 `allowed_actions`。

---

## 任务 8：桌面端托盘图标状态指示

**文件**：`windows/LanPower.Desktop/`（WPF 项目）、`windows/LanPower.Service/`（Windows 服务）

### 需求
系统托盘图标直观反映 Cloud Agent 连接状态，用户无需打开主窗口即可知道当前联网情况。

### Windows 服务端需求
现有的 `/api/status` 接口（本地 HTTP，端口 48211）响应体中新增两个字段：
- `cloud_connected`（布尔）：当且仅当最近 90 秒内 Cloud 端轮询有成功响应时为 `true`。
- `cloud_last_seen`（整数，Unix 时间戳）：最近一次成功与 Cloud 通信的时间。

### 桌面端需求
- 准备三个 16×16 像素的托盘图标资源：绿色（云端已连接）、黄色（服务运行但云端断线）、灰色（服务未运行），放入 `windows/LanPower.Desktop/Resources/`。
- 桌面端每 30 秒轮询一次本地服务 `/api/status`：
  - 无法连接本地服务 → 灰色图标
  - 服务响应但 `cloud_connected=false` → 黄色图标
  - 服务响应且 `cloud_connected=true` → 绿色图标
- 托盘图标的 Tooltip 文字同步更新，分别显示"LanPower · 已连接云端"、"LanPower · 未连接云端"、"LanPower · 服务未运行"。

---

## 任务 9：RDP 远程桌面快捷入口

**文件**：`cloud_app/templates/dashboard.html`

### 需求
设备在线时，控制台直接提供远程桌面连接的快捷方式，省去用户手动输入 IP 的步骤。

### 具体要求
- `DeviceHeartbeat` 表中已有 `lan_ip` 字段，`platform.device_status()` 已经将其包含在返回值中，前端直接使用即可，后端无需修改。
- `dashboard.html` 中，当设备在线且 `lan_ip` 不为空时，显示以下两个控件：
  - "远程桌面"按钮：链接格式为 `rdp://full%20address%3Ds%3A{lan_ip}%3A3389`，点击后由操作系统或已安装的 RDP 客户端处理跳转。
  - "复制 IP"按钮：点击将 `lan_ip` 写入剪贴板，为不支持 `rdp://` 跳转的场景兜底。
- 按钮样式沿用现有 `.btn-*` 样式类，与设备卡片现有操作按钮视觉一致。
- 设备离线时不显示这两个控件。

---

## 任务 10：设备离线微信订阅消息通知

**文件**：`cloud_app/app/models.py`、新建 `cloud_app/app/notify.py`、`cloud_app/app/main.py`、`cloud_app/templates/settings.html`、`cloud_app/app/settings.py`、Alembic 迁移

### 需求
当监控的设备超过预设时间未上线时，通过微信订阅消息主动推送通知。

### 数据模型
新增 `notification_configs` 表，字段包含：
- 关联用户（owner_id）和目标设备（device_id）
- 接收通知的微信用户 openid
- 微信订阅消息模板 ID
- 离线判定阈值（分钟，默认 5）
- 启用/禁用开关
- 上次发送通知时间（防重复推送）

### 通知逻辑
- 通知检测集成到任务 4 的调度器中，每次 tick 同时检查离线告警。
- 判断条件：`enabled=true` 且目标设备最新心跳时间距今超过阈值分钟数，且上次通知时间距今超过 1 小时。
- 微信 access_token 按需获取（调用微信 `client_credential` 接口），缓存约 7000 秒后重新获取。
- 推送内容至少包含：设备名称、离线时间。

### 配置
`Settings` 类新增可选配置项，通过环境变量读取：
- `WX_APP_ID`：微信小程序 AppID
- `WX_APP_SECRET`：微信小程序 AppSecret

这两项不填时，通知功能静默禁用，不影响其他功能。

### 配置界面
`settings.html` 追加"离线通知"区块，表单包含：选择设备、输入微信 openid、输入模板消息 ID、设置阈值分钟数、启用/禁用开关。提交后保存到 `notification_configs` 表，同一设备可设置多个接收人。

---

## 任务 11：云端控制台移动端响应式适配

**文件**：`cloud_app/static/`（CSS 文件）、`cloud_app/templates/base.html`、`dashboard.html`、`devices.html`、`activity.html`

### 需求
在手机浏览器（约 375–480px 宽度）下，控制台主要功能可正常使用，无横向滚动，操作按钮触控友好。

### 具体要求
- `base.html` 的 `<head>` 中确保包含正确的 `viewport` meta 标签（`width=device-width, initial-scale=1`）。
- 在现有 CSS 文件末尾追加媒体查询，断点设在 640px，不修改任何现有桌面样式。
- 小屏下的布局调整：
  - 侧边导航隐藏或折叠为汉堡菜单。
  - 设备卡片/列表变为单列布局。
  - 操作按钮变为全宽，最小点击高度 44px，满足触控目标尺寸要求。
  - 表格中次要列（如版本号、协议版本）在小屏下隐藏，保留关键列（名称、状态、操作）。
  - 表单输入框变为全宽。
- 不引入新的 CSS 框架或 JS 库，使用原生 CSS（flex、grid、clamp）实现。
- 改动后在桌面宽度下视觉应与改动前完全一致（媒体查询不影响桌面）。

---

## 版本号更新

完成全部任务后，将以下位置的版本号统一更新为 **1.7.0**：

| 文件 | 字段 |
|------|------|
| `VERSION` | 文件全部内容 |
| `cloud_app/pyproject.toml` | `version = "..."` |
| `cloud_app/app/main.py` | `VERSION = "..."` |
| `windows/Directory.Build.props` | 版本号属性字段 |

同步更新 `README.md`：
- 版本对照表中 Cloud 版本改为 `1.7.0`。
- 新增 v1.7 功能概要列表（一句话描述每项新功能）。

---

## 执行顺序

任务 1（数据库基础）优先执行。任务 4（调度器）需在任务 10（离线通知）之前完成，因为两者共享同一调度器。其余任务之间无依赖，可并行执行。

---

*文档版本：2026-10-01 | 基于 LanPower v1.6.1*
