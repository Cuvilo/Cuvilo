# 应用图标源文件

- `app-icon-source.png`：当前图标的栅格源文件。
- `app-icon.svg`：包含源图与现有裁切/缩放布局的SVG，用于重新生成图标。
- `../src-tauri/icons/`：当前原生窗口、托盘和安装包使用的图标。
- `../public/brand/` 与 `../public/favicon.png`：当前界面和预览资源。

更换源图后需同步更新SVG中的内嵌内容与布局，并检查16/24/32px缩小效果。可使用Tauri icon命令生成中间产物，核对后再替换正式资源；不要把临时生成的其他平台图标提交到仓库。

图标变化不改变应用identifier、数据库位置与Windows凭据命名空间。
