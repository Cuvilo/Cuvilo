# 贡献指南

感谢帮助改进 Cuvilo。小问题可直接提交 Issue；较大功能请先说明使用场景和拟修改范围，便于讨论。

## 反馈

[创建故障反馈或功能建议](https://github.com/Cuvilo/Cuvilo/issues/new/choose)。请使用合成文本、示例材料和本地模拟服务，不要提供真实 API Key、个人简历、录音或完整云端响应。

## 开发和验证

项目需要 Windows x64，详细依赖见[桌面开发说明](desktop/README.md)。

```powershell
cd desktop
npm ci
npm test
npm run build
./tools/test-native.ps1
```

原生命令使用 Visual Studio 开发者终端及 Rust MSVC。系统 OCR、窗口合成和真实云端测试的环境要求见[验证说明](desktop/VALIDATION.md)；不要用实际会议或私人材料代替测试夹具。

## 提交 Pull Request

- 说明解决的问题、用户可见变化和完成的验证；界面改动附合成数据截图。
- 保持改动范围集中，沿用现有组件、语义配色及键盘交互。
- 不改变应用 identifier、数据目录、Windows 凭据命名空间或已发布的更新公钥。
- 不提交依赖目录、编译产物、私钥、个人数据或 `.local/` 内容。
- 功能或行为变化同步更新必要文档和更新记录。

提交的贡献应有权按项目的 GPL-3.0（仅第三版）许可提供。第三方代码必须保留其原有版权与许可声明。
