# Cuvilo

**听清问题，整理你的回答思路。**

Windows 实时面试练习助手，支持实时转写、截图提问与个人资料检索。

**[下载 Windows 版](https://github.com/Cuvilo/Cuvilo/releases/latest)** · [使用指南](https://github.com/Cuvilo/Cuvilo/blob/main/docs/GETTING_STARTED.md) · [常见问题](https://github.com/Cuvilo/Cuvilo/blob/main/docs/FAQ.md) · [项目源码](https://github.com/Cuvilo/Cuvilo)

<details>
<summary>查看完整项目介绍：界面预览、安装说明与开发文档</summary>

![首页与首次使用引导](https://raw.githubusercontent.com/Cuvilo/Cuvilo/main/docs/images/home-guide.png)

## 下载与安装

前往 **[最新正式版](https://github.com/Cuvilo/Cuvilo/releases/latest)**，下载名字以 `x64-setup.exe` 结尾的安装包，运行后按照提示安装。

| 文件 | 用途 |
| --- | --- |
| `Cuvilo_<版本>_x64-setup.exe` | **Windows x64 安装包，普通用户下载这个** |
| `.sig`、`latest.json` | 软件自动更新使用的签名与清单，无需手动下载 |
| GitHub 自动提供的 `Source code` | 对应标签的源码快照，不是可运行的安装包 |

当前提供 Windows x64 版本，建议在 Windows 11 上使用。macOS、Linux、Windows ARM64 暂无原生发行版。指定应用声音采集需要 Windows build 20348 或以上；不满足时请选择系统声音。具体兼容范围见[使用指南](https://github.com/Cuvilo/Cuvilo/blob/main/docs/GETTING_STARTED.md)。

## 能做什么

- **实时听题**：采集系统或指定应用的声音并转写，可按需加入本人麦克风上下文。
- **整理回答思路**：结合个人经历与相关知识片段生成流式参考答案，支持手动提问、重新回答和逐段代码复制。
- **截图提问**：识图模型直接理解选区；未指定或识图失败时，使用所选 OCR 服务提取文字后交给对话模型。
- **管理个人资料**：支持 PDF、DOCX、UTF-8 TXT 和 Markdown；个人经历与知识资料分开管理。
- **回看与导出**：保存文字转写、参考答案和面试历史，可导出 Markdown 并备份数据。
- **专注阅读**：独立答案窗口、浅色/深色/跟随系统、背景透明度、字号和生成字数设置。

## 界面预览

| 实时问答 · 深色 | 截图代码题 · 浅色 |
| :---: | :---: |
| <img src="https://raw.githubusercontent.com/Cuvilo/Cuvilo/main/docs/images/answer-dark.png" width="360" alt="深色答案窗口与演示缓存问题回答"> | <img src="https://raw.githubusercontent.com/Cuvilo/Cuvilo/main/docs/images/code-answer.png" width="360" alt="浅色截图代码题与代码复制入口"> |

截图来自实际前端的隔离演示模式，只含合成问题、演示资料与模拟回答；不代表真实服务的识别准确率、响应速度或测评结果。

## 第一次使用

1. **连接回答模型**：点击首页“会前准备”右侧的“使用引导”，填写自己的模型 API Key，检测并保存。
2. **连接语音识别**：选择语音服务，填写所需凭据，检测并保存。
3. **检测会议声音**：播放一段测试声音，选择系统声音或目标应用并检测；随后开始练习。

需要结合个人背景回答时，可先在“个人材料”导入简历或知识资料。完整图文步骤见 **[使用指南](https://github.com/Cuvilo/Cuvilo/blob/main/docs/GETTING_STARTED.md)**。

Cuvilo 本身不提供模型或语音额度，需要自行配置相应服务。第三方服务的开通、地区、计费和额度由平台决定；支持的服务及官方入口见[服务配置说明](https://github.com/Cuvilo/Cuvilo/blob/main/docs/GETTING_STARTED.md#服务与官方入口)。

## 数据与隐私

文字记录、材料和设置存于本机；服务密钥存于 Windows 凭据管理器。使用云端语音、回答模型、识图或 OCR 时，相应音频、文字、材料片段或图片会发送给所选服务。默认不保存原始录音，知识资料使用本地关键词检索，不下载 embedding 模型。

更多信息见[数据与隐私说明](https://github.com/Cuvilo/Cuvilo/blob/main/docs/PRIVACY.md)。提交公开反馈时，请移除密钥和个人材料。

## 帮助与反馈

- [没有声音、识别失败、模型配置、更新和备份等常见问题](https://github.com/Cuvilo/Cuvilo/blob/main/docs/FAQ.md)
- [报告故障或提出功能建议](https://github.com/Cuvilo/Cuvilo/issues/new/choose)
- [版本更新记录](https://github.com/Cuvilo/Cuvilo/blob/main/CHANGELOG.md)
- [安全问题反馈](https://github.com/Cuvilo/Cuvilo/blob/main/SECURITY.md)

## 开发与贡献

使用 Tauri 2、Rust、React、TypeScript、shadcn/ui 和 SQLite。需要 Windows x64、Node.js、Rust MSVC、Visual Studio C++ 构建工具和 WebView2；已在 Node.js 22 与 Rust 1.95 环境验证。

```powershell
cd desktop
npm ci
npm run tauri dev
```

[桌面开发说明](https://github.com/Cuvilo/Cuvilo/blob/main/desktop/README.md) · [贡献指南](https://github.com/Cuvilo/Cuvilo/blob/main/CONTRIBUTING.md) · [验证记录](https://github.com/Cuvilo/Cuvilo/blob/main/desktop/VALIDATION.md) · [发布维护说明](https://github.com/Cuvilo/Cuvilo/blob/main/RELEASING.md)

## 许可证

Copyright (C) 2026 Cuvilo contributors.

本项目按 **GNU General Public License version 3（GPL-3.0，仅第三版）** 发布，详见 [LICENSE](https://github.com/Cuvilo/Cuvilo/blob/main/LICENSE)。软件按原样提供，不附带担保。第三方依赖保留各自的版权与许可声明，例如 [shadcn/ui](https://github.com/Cuvilo/Cuvilo/blob/main/desktop/public/licenses/shadcn-ui.txt)。

</details>
