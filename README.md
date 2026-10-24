# Cuvilo

Windows 实时面试练习助手，使用 Tauri 2、Rust、React、TypeScript、shadcn/ui 和 SQLite。

## 功能

- 采集系统声音或指定应用声音，实时转写；可选额外麦克风上下文。
- 结合个人经历与知识资料生成流式参考答案，支持手动提问、代码复制、展开和重新回答。
- 截图提问：指定识图模型直接理解图片，失败时回退至所选 OCR 服务与对话模型。
- 导入 PDF、DOCX、UTF-8 TXT 和 Markdown；个人经历与知识资料分开管理。
- 本地面试历史、Markdown 导出、数据备份恢复、自定义快捷键、深浅色主题与独立答案窗口。

当前版本：**0.1.51**。当前原生实现面向 Windows，尚不支持 macOS。

## 第一次使用

1. 点击首页“会前准备”右侧的“使用引导”，配置回答模型、语音识别并检测会议声音；也可在“设置 → 服务”中管理。
2. 在个人材料中导入简历、项目经历或知识资料，并确认提取的文字。
3. 选择系统声音或目标应用，按需启用麦克风，开始面试练习。
4. 在答案窗口查看参考回答；截图和手动提问可从阅读菜单或快捷键打开。

回答模型支持兼容 Chat Completions 的接口。语音服务支持阿里云、讯飞、腾讯云、火山引擎，以及分段上传的 OpenAI Audio Transcriptions 接口；后者需要等待片段上传与识别。服务可用性、开通要求和额度以各平台为准。

## 开发

需要 Windows x64、Node.js、Rust MSVC 工具链、Visual Studio C++ 构建工具和 WebView2。项目已在 Node.js 22 与 Rust 1.95 的 MSVC 环境验证。

```powershell
cd desktop
npm ci
npm run tauri dev
```

仅预览界面：

```powershell
npm run dev
```

浏览器预览使用演示数据，不会采音或读取桌面客户端中的真实凭据。

## 测试与构建

```powershell
cd desktop
npm test
npm run build
cd src-tauri
cargo test --lib
```

在 Visual Studio 开发者终端中打包，执行前从托盘正常退出客户端：

```powershell
cd desktop
npm run package
```

产物为 `desktop/src-tauri/target/release/cuvilo.exe` 和 `desktop/src-tauri/target/release/bundle/nsis/Cuvilo_<版本>_x64-setup.exe`。它们是本地构建产物，不提交到源码仓库；分发时可单独上传至 GitHub Releases。

## 数据与隐私

- 设置、材料和文字记录存于 `%APPDATA%/local.interview.copilot/`。
- 服务密钥存于 Windows 凭据管理器，命名空间为 `InterviewCopilot/`。
- 默认不保存原始录音。语音发送给所选语音服务，回答所需的材料片段与文本发送给所选模型。
- 使用云端识图或 OCR 时，所选图片会发送给相应服务。本地 OCR 使用 Windows OCR 及系统语言组件。
- 知识资料使用本地关键词检索与片段预算，不下载 embedding 模型。
- 数据备份、日志、录音、配置恢复副本和 `.local/` 均不应上传 GitHub。

关闭主窗口的行为可在偏好中设置；完全退出可使用托盘菜单。

## 目录与文档

- `desktop/src/`：界面、交互状态与前端测试。
- `desktop/src-tauri/src/`：采音、语音连接、问答、OCR、文档提取和存储。
- `desktop/tools/`：正式构建、产物清理与资源测量工具。
- [桌面开发说明](desktop/README.md)
- [界面维护规范](desktop/UI_GUIDE.md)
- [验证说明](desktop/VALIDATION.md)
- [更新记录](CHANGELOG.md)
- [维护规则](AGENTS.md)

## 自动更新与发布

0.1.48 起支持启动检查、点击下载和确认后重启更新。发布配置与首次仓库设置见 [发布说明](RELEASING.md)。
