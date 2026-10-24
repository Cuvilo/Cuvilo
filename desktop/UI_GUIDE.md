# 界面维护说明

通用约束见 [AGENTS.md](../AGENTS.md)。本文件仅说明当前实现，不保留已经废弃的设计草稿与历次交付流水。

## 实现位置

| 区域 | 主要文件 |
| --- | --- |
| 框架与导航 | `src/App.tsx`、`src/components/app-navigation.tsx` |
| 会前准备与转写 | `interview-view.tsx`、`transcript-workspace.tsx`、`use-transcript-feed.ts` |
| 答案与截图提问 | `answer-window.tsx`、`answer-panel.tsx`、`screen-question.tsx` |
| 历史复盘 | `history-view.tsx`、`review-workspace.tsx` |
| 材料与导入 | `materials-view.tsx`、`material-import-dialog.tsx`、`use-material-import.ts` |
| 服务设置 | `settings-view.tsx`、`settings-provider.tsx`、`provider-presets.ts` |
| 状态与自动保存 | `use-copilot.ts`、`use-preference-autosave.ts`、`state.ts` |
| 主题与动效 | `src/styles.css`、`use-theme.ts`、`src/lib/motion.ts` |
| 公共控件 | `src/components/ui/`、`common.tsx` |

组件文件位于 `src/components/`，hook位于 `src/hooks/`，辅助逻辑位于 `src/lib/`。

## 当前交互

- 托盘版本项共用更新流程；标题栏提示可按目标版本隐藏，托盘与关于页入口始终保留。
- 首页“会前准备”标题右侧常驻使用引导入口，关于页不再重复入口；初次引导含模型、语音与声音检测三步，完成后自动收起。标题与内容框分离，最近面试保留独立的圆角列表与分隔线。
- 手动提问位于答案阅读菜单；设置保留服务、偏好、快捷键、数据和关于分区。
- 历史采用记录列表与复盘双栏，窄窗切换列表/详情；批量管理图标与完成勾选占用同样大小。
- 个人经历与知识资料分开管理；知识入口中的拖入、导入、新建只使用知识类型。
- 设置检测结果放在底部固定槽中，不撑高弹窗；失败详情通过共享Tooltip与无障碍文本读取。
- 配置帮助使用厂商官方控制台链接；编辑器不显示重复解释性小字。
- 答案来源和整段复制在同一工具行，代码块另有复制按钮。
- 主题切换使用统一180ms过渡，原生标题栏与WebView共同准备后播放；跟随系统不能依赖被窗口强制主题影响的媒体查询。
- 背景透明度独立于前景文字。设置预览与落盘分开，失败保留重试。

## 样式原则

使用语义变量与公共组件，局部样式用明确className/cn，响应式规则放在对应层。保持现有字号、圆角与4px间距节奏，不恢复大卡片、蓝色主按钮或重复品牌区域。

所有滚动区祖先须有 `min-height:0`；保留DOM、ref和锚点。侧栏变宽、问题展开、菜单打开及文本修订不应造成阅读位置跳动。

## 检查

运行前端测试和生产构建。尺寸、原生窗口及交付检查见 [VALIDATION.md](VALIDATION.md)。浏览器预览只验证合成界面；不得把预览截图作为真实云端、采音或系统标题栏的通过证据。
