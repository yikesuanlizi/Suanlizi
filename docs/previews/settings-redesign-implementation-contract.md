# Suanlizi 设置页重设计实现约束

本文档是设置页正式落代码的检查清单。预览文件只用于验证布局方向，不能作为真实设置功能的替代实现。

## 信息架构

- 顶层设置页只保留：模型、外观、记忆、性能、插件中心、远程助手、监控、关于、管理员（仅 admin 可见）。
- MCP 不允许成为单独顶层设置页。MCP 是插件中心内部的二级 tab。
- 插件中心内部保留四个二级入口：推荐、MCP、Skills、联网工具。
- 不恢复“设置作用域”解释条。作用域可以作为内部状态/保存逻辑存在，但主设置界面不展示大段解释。

## 模型页

- 顺序固定为：默认模型 → 密钥 → 预设。
- “OpenAI-compatible” 是通用 OpenAI 协议 provider，不叫“自定义”。
- 选择 OpenAI-compatible 后展示厂商名称字段，厂商名称可以填 ai.gitee、OpenRouter、LMStudio 等。
- ai.gitee 这类用户创建项不能出现在“模型提供方”顶层分组里；它只能作为 OpenAI-compatible 的厂商名称或预设名称出现。
- 切换官方 provider 时，模型和 API 地址要同步到该 provider 默认值，不能留下上一个 OpenAI-compatible 厂商的 baseUrl。
- 密钥区域放在默认模型下面，不放到预设上面或页面底部。
- 环境变量 / 已保存密钥切换必须稳定，用户手动切到环境变量时不能闪回已保存密钥。
- 环境变量候选需要包含当前进程、Windows 用户变量、Windows 系统变量。
- 预设放在模型页底部；删除入口放在预设下拉项内，不额外占一整行。

## 子页内容完整性

正式实现必须以现有 React page 组件为真实内容来源，重排时不能删字段：

- `ModelsPage.tsx`：provider、厂商名称、model、baseUrl、密钥来源、环境变量、批量设置、保存密钥、预设载入/保存/删除。
- `AppearancePage.tsx`：主题、语言、头像、界面显示相关选项。
- `MemoryPage.tsx`：长期记忆、冷记忆、episode 记忆、注入限制、token 预算、记忆列表操作。
- `MonitorPage.tsx`：运行监控、trace、item timeline、采样/保留相关配置。
- `ToolsPage.tsx`：推荐插件、MCP、Skills、联网工具，保持内部 tab。
- `AgentsPage.tsx`：微信、飞书、钉钉、DWS CLI、QQ/A2A 等已有远程助手配置。
- `AboutPage.tsx`：版本、运行环境、admin token 管理等已有内容。

## 视觉和交互

- 字号和字重降低：正文 12px 左右，label 11px 左右，标题只在层级入口加粗。
- 避免“一块大框占一整行”：相关字段用两列/三列或紧凑列表排布。
- dirty 高亮只能包住具体输入控件，不能让整行 label 或整个 section 出现黄色边框。
- 下拉菜单必须可点击、可关闭、可滚动；预设删除按钮点击时不能触发载入预设。
- 窄宽度下内容必须自适应，不允许右侧栏或设置弹层被遮住。

## 浏览器验收

- 内置浏览器打开设置页，顶层导航中不存在 MCP。
- 插件中心内能切换 推荐 / MCP / Skills / 联网工具。
- 模型页选择 OpenAI-compatible 时出现厂商名称；页面上不存在“自定义”作为 provider 文案。
- 预设下拉可展开，删除按钮位于下拉项内。
- 默认模型、密钥、预设的上下顺序正确。
- 控制台 0 error / 0 warn；无横向滚动和遮挡。
