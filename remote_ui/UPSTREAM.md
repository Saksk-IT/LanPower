# 上游与整合范围

复用用户指定的 Codex Remote Bridge 0.1.101（1bbcf5a）网页组件、消息归一化和桌面 renderer 适配机制。该项目基于 friuns2/codex-mobile / pavel-voronin/codex-web-local，版权和 MIT 许可完整保留在 LICENSE。

LanPower 使用自己的页面容器和已认证 WSS 通道，不运行上游 Node 服务，不复制其账号、提供商、隧道、遥测或本机部署配置。排队、历史分页和审批由受控 Windows 执行。源码目录与生成静态资源均包含许可；升级需复核原生接口兼容性。

LanPower 1.18.0 增加正文与引用分离、稳定轮次操作、Unicode 输入校验、公开工具卡片、授权聊天元数据查询及图片引用管理。相关回归见仓库 docs/codex-remote-first-six-fixes.md。以上适配保留上游许可，生成资源与源码同步构建。
