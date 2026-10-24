# 发布与自动更新

从 0.1.48 起内置 Tauri 官方 updater。更新清单位于：

`https://github.com/Cuvilo/Cuvilo/releases/latest/download/latest.json`

客户端启动后检查；有新版时在主窗口原生标题栏最小化键左侧显示带边框的“下载更新”。点击后显示旋转图标与下载进度，验证签名成功后原位变为“重启更新”，不增加内容区横条。关于页可手动检查、下载及重试。面试开始会中止下载，结束后可重新点击下载。安装必须由用户操作发起：标题栏与关于页点击后确认重启，托盘新版版本号点击后自动完成下载与安装；面试期间禁止安装。未保存的服务配置、材料编辑或导入会阻止安装；偏好先刷新到磁盘，数据库校验并生成完整恢复副本成功后才启动安装器。安装器使用原 identifier 和每用户安装目录，保留现有 AppData 和 Windows 凭据。

托盘没有更新时显示当前版本，有更新时原位只显示新版版本号；点击新版版本号即可自动下载、验证签名、保存偏好并重启安装，不额外弹确认框。下载期间版本号保持显示且禁用。标题栏按钮的边框为88px宽，悬停时框外右上角显示“×”；关闭后记住目标版本，同一更新重新检查和重启后不再显示提示，新版本再次显示。隐藏不影响托盘及关于页操作。

## 首次配置仓库（只做一次）

1. 仓库地址为 `https://github.com/Cuvilo/Cuvilo`，上传当前干净源码。
2. 在仓库 **Settings → Secrets and variables → Actions → New repository secret** 添加 `TAURI_SIGNING_PRIVATE_KEY`，值为本机私有签名文件的完整内容。不要将文件上传到仓库，不要粘贴到聊天或 issue。
3. 当前生成的密钥没有密码，`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 可不设置。如果以后使用加密密钥，再将密码加入这个 secret。
4. 将签名私钥另外保存到可靠的私有备份。客户端内置的公钥与它配对；首个版本发布后不能随意更换，否则已安装用户无法验证后续版本。
5. 打开 **Actions → Release Windows → Run workflow**，在 main 上运行。工作流执行测试后生成签名安装包、`.sig` 与 `latest.json`，只创建草稿 Release。
6. 检查草稿附件中的 `Cuvilo_0.1.51_x64-setup.exe`、对应 `.sig` 和 `latest.json`，确认无误后点 **Publish release**。首次公开版本下载并使用安装包安装；0.1.47 及更早版本需手动安装一次。

签名公钥已写入 `desktop/src-tauri/tauri.conf.json`，可以公开；私钥只存在本机忽略目录。整个 `.local/` 不属于公开源码。

## 发布后续版本

同时更新 `desktop/package.json`、`desktop/package-lock.json`、`desktop/src-tauri/Cargo.toml`、`desktop/src-tauri/Cargo.lock` 和 `desktop/src-tauri/tauri.conf.json` 中的应用版本，并更新 CHANGELOG。执行前端与原生测试，使用 `node tools/check-release.mjs` 核对版本一致性。

推送源码和与版本一致的标签，例如 `v0.1.51`，会触发工作流。也可在 main 上手动 Run workflow。构建成功后查看并发布草稿，旧客户端即可发现新版。草稿和预发布不作为稳定更新。

如果当前有草稿，请先处理该草稿，再触发相同版本工作流。已经发布的版本不要覆盖重发；修复问题时提高版本号。

## 本地打包

在 Visual Studio 开发者终端中执行 `npm run package`。脚本优先使用环境变量 `TAURI_SIGNING_PRIVATE_KEY`，本机维护时也可使用仓库忽略目录 `.local/updater/cuvilo.key`；没有签名私钥会明确失败，不会生成无法验证的更新。

本机生成的私钥文件位于 `.local/updater/cuvilo.key`，备份位于 `.local/backups/updater-signing/cuvilo.key`。设置 GitHub Secret 时复制的是文件内容，不能只填路径。

首次运行前从托盘退出旧客户端。安装包、对应 `.sig` 在 `desktop/src-tauri/target/release/bundle/nsis/`。GitHub 工作流使用官方 tauri-action 生成 `latest.json`，不能只上传 EXE。

## 验证边界

发布第一版之前，远端更新清单不存在是正常情况；手动检查会提示尚未发布可用更新。网络失败允许重试，不影响面试。首次完整线上升级需要两个已发布的不同版本，并在隔离用户资料下验证；本地单元测试和签名测试不能代替这一步。
