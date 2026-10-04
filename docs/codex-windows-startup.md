# Windows Codex Remote 自动启动与重连

Windows / Cloud / Web `1.18.2`、小程序 `3.0.3` 修复重启后需要手动打开 CodexDock 的问题。安装或升级后，已登录的 Windows 用户无需点击桌面图标，即可运行已授权的 Codex Remote。

## 启动与恢复

- 电源与 Cloud 后台服务随 Windows 启动；Codex Host 在用户登录 Windows 后自动启动，使用该用户已有的 Codex 登录和项目授权。
- 安装器注册 `LanPower Codex Remote` 登录任务，并每分钟检查一次。Host 意外退出或正常结束后，通常在一分钟内重新启动；已运行时忽略重复触发，界面不弹出。
- 原 Codex 窗口重启或连接中断后，有远程页面连接时，Host 自动重新接入该用户的原窗口。失败后按 2、4、8、16、30 秒退避重试，成功后网页和小程序重新读取实际历史、队列、任务与审批状态。
- 恢复连接只读取实际状态，不重复发送任务、队列或审批；关闭开发授权后不再重连。独立执行模式不自动重启自有任务进程。
- 安装器先暂停恢复任务再更新文件，完成后重新注册并启动；便携安装使用相同流程。卸载先停止并删除任务，保留用户配置及配对数据。

自动启动任务使用 Windows 交互用户组和最低权限，不保存 Windows 密码。电池供电不会停用任务，运行没有默认三天时限。升级会移除指向本安装目录的旧启动文件夹快捷方式。

电脑开机但尚未登录 Windows 时，Codex Remote 会等待用户登录。原窗口控制仍要求官方 Codex 已打开、已登录并启用本机连接接口；首次使用按 [原窗口整合](codex-original-window.md) 连接。CodexDock 不会强制关闭或重启官方 Codex。

## 验证

自动检查覆盖登录任务、交互用户和权限、电池与无限运行、退出恢复、升级暂停、卸载清理，以及连接失败退避、授权撤销、已有任务/队列恢复且不重发。验证过程不重启正在工作的官方 Codex，不执行电源命令。

本机安装、实际后台进程退出恢复及数据保留结果记录在 [本机开发指南](local-development.md)。真实 Windows 重启、退出登录再登录及真实 Codex 重启仍需人工验收。

任务原理参考：[Windows 任务运行身份](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal)、[无限重复周期](https://learn.microsoft.com/en-us/windows/win32/taskschd/repetitionpattern-duration)。
