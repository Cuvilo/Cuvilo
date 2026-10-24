# 桌面客户端开发说明

项目概览、使用和数据位置见[根目录说明](../README.md)。业务源码位于本目录，使用单套 Tauri 2 / Rust / React / TypeScript / shadcn/ui 实现。

## 常用命令

在本目录执行：

```powershell
npm ci
npm run tauri dev
npm test
npm run build
npm run package
```

正式打包使用 Visual Studio 开发者终端；`npm run package` 会核对运行中的客户端并在成功构建后清理旧安装包。当前运行的客户端需要先保存并从托盘退出，脚本不会强制结束它。

构建缓存和依赖已加入 Git 忽略规则。清理后首次构建会重新安装依赖、编译 Rust 和获取打包工具，不影响 AppData 中的用户数据。

## 浏览器预览

`npm run dev` 默认提供 `http://127.0.0.1:1420/`：

| 参数 | 页面 |
| --- | --- |
| `?page=settings` | 设置 |
| `?page=materials` | 个人材料 |
| `?page=history` | 历史记录 |
| `?demo=live` | 会话演示 |
| `?window=answer&demo=live` | 独立答案窗口演示 |

浏览器仅使用演示内容。真实采音、Windows 凭据、原生窗口和 OCR 需在桌面客户端验证。

## 原生检查

在 `src-tauri/` 执行：

```powershell
../tools/test-native.ps1
cargo check --release
cargo run -- --diagnostics
```

`--diagnostics` 输出音源和系统信息，不上传音频。`--audio-probe` 会临时采集音频并输出统计，需在用户明确安排后使用；不用于普通构建检查。

原生可视/网络集成测试默认忽略。独立运行需要对应环境、Windows 公共控件 manifest，部分测试还需要界面预览服务。测试 manifest 保存在 `test-fixtures/windows.manifest`，不要对正在运行的测试 EXE 修改 manifest。

## 维护边界

- 应用 identifier 固定为 `local.interview.copilot`；品牌变化不改变数据库和凭据位置。
- 主窗口管理会前准备与复盘，独立答案窗口负责问答阅读。
- 个人经历作为事实上下文；知识资料通过本地关键词评分选取片段，不增加向量模型。
- 截图识图最多回退一次 OCR + 对话模型；取消与结束会话后，旧任务不得回填。
- Windows OCR 不等于内置跨平台 OCR；macOS 需要独立实现采音、截图、凭据和窗口适配。
- 运行产物、个人材料、密钥、本地备份及诊断日志不属于公开源码。

界面规范见 [UI_GUIDE.md](UI_GUIDE.md)，验证基线见 [VALIDATION.md](VALIDATION.md)。

## 发布与更新

首次发布及 GitHub 签名 secret 配置见 [发布说明](../RELEASING.md)。更新签名私钥不会进入 Git，公开版本必须使用同一套签名。
