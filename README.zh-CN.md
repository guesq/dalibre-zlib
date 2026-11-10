# Dalibre Z-Library 插件 (`zlib.books`)

[English](./README.md) | 简体中文

一个跨平台的 [Dalibre](https://github.com/djyde/dalibre) **Get Books** 书源插件，通过本地 [zlib CLI (`heartleo/zlib`)](https://github.com/heartleo/zlib) 提供 Z-Library 热门/推荐/收藏榜单浏览、多条件检索、封面加载及一键下载导入 Calibre 书库功能，支持 **macOS、Linux 和 Windows**。

---

## 1. 前置要求：安装与配置 `zlib` CLI

本插件依赖本地安装的 [`heartleo/zlib`](https://github.com/heartleo/zlib) 命令行工具以及 **Node.js（`>= 18`）**。

### 各平台安装 `zlib` CLI

- **macOS / Linux (Homebrew)**：
  ```bash
  brew install heartleo/tap/zlib
  ```
- **Linux / macOS (官方安装脚本)**：
  ```bash
  curl -fsSL https://raw.githubusercontent.com/heartleo/zlib/main/install.sh | sh
  ```
- **Windows (WinGet)**：
  ```powershell
  winget install --id heartleo.zlib --exact
  ```
- **全平台通用 (Go `>= 1.25`)**：
  ```bash
  go install github.com/heartleo/zlib/cmd/zlib@latest
  ```

### 登录 Z-Library 账号

```bash
# 1. 登录你的 Z-Library 账号（凭证保存在 ~/.config/zlib/.env）
zlib login

# 2. 验证登录状态与每日可用下载额度
zlib profile
```

---

## 2. 安装与启动本地 Bridge 服务

由于 Dalibre 插件运行在沙箱化的 QuickJS 环境中（不支持直接调用本地二进制命令，且限制动态第三方下载 CDN 域名），插件通过内置的跨平台轻量 HTTP 服务（默认监听 `http://localhost:17890`）调用 `zlib` CLI。

你可以根据习惯选择以下 **3 种方式之一** 来运行或分发 Bridge：

### 方式一：在克隆的代码仓库中直接启动

```bash
# macOS / Linux
./scripts/service.sh          # 启动后台服务（默认动作即为 start）
./scripts/service.sh status   # 查看运行状态及当前生效的系统代理/域名配置
./scripts/service.sh stop     # 停止后台服务

# 跨平台通用 (Windows / macOS / Linux)
node plugins/zlib/bridge.mjs start
node plugins/zlib/bridge.mjs status
node plugins/zlib/bridge.mjs stop
```

### 方式二：通过 `npm` 全局安装为跨平台命令行工具 (`dalibre-zlib-bridge`)

```bash
# 直接从 GitHub 全局安装
npm install -g github:guesq/dalibre_zlib

# 安装后可在 macOS / Linux / Windows 任意终端直接调用：
dalibre-zlib-bridge start
dalibre-zlib-bridge status
dalibre-zlib-bridge stop
```

### 方式三：直接从 Dalibre 已安装的插件目录启动（免克隆仓库）

因为 `bridge.mjs` 已经打包在 `zlib.books-*.dalibre-plugin` 插件包内部，当你通过 Dalibre 的 **Install from GitHub** 或离线包安装好插件后，`bridge.mjs` 就已经解压在 Dalibre 的本地插件目录中，可直接用 `node` 启动：

- **macOS**：
  ```bash
  node "$HOME/Library/Application Support/Dalibre/plugins/zlib.books/bridge.mjs" start
  ```
- **Linux**：
  ```bash
  node "$HOME/.config/Dalibre/plugins/zlib.books/bridge.mjs" start
  ```
- **Windows (PowerShell)**：
  ```powershell
  node "$env:APPDATA\Dalibre\plugins\zlib.books\bridge.mjs" start
  ```

---

### 可选：注册系统开机/登录自启动服务 (`install-service`)

如果你希望登录系统后自动在后台启动 Bridge（无需每次手动运行）：

```bash
# 可使用仓库脚本、全局命令或直接用 node bridge.mjs 执行：
./scripts/service.sh install-service
# （或：dalibre-zlib-bridge install-service）

# 如需取消开机自启并停止服务：
./scripts/service.sh uninstall-service
# （或：dalibre-zlib-bridge uninstall-service）
```

`install-service` 在不同操作系统下的实现机制：
- **macOS**：自动创建并加载用户级 `LaunchAgent`（`~/Library/LaunchAgents/com.dalibre.zlib-bridge.plist`）。
- **Linux**：自动创建并启用用户级 `systemd` 服务（`~/.config/systemd/user/dalibre-zlib-bridge.service`）。
- **Windows**：自动在当前用户的开机「启动」目录生成无窗口启动脚本（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dalibre-zlib-bridge.vbs`）。

---

## 3. 在 Dalibre 中安装与使用插件

### 安装插件

打开 **Dalibre** → **Plugins**（插件管理）：

- **从 GitHub 安装**：点击 **Install from GitHub**，输入 `guesq/dalibre_zlib`（或 `https://github.com/guesq/dalibre_zlib`），支持从 GitHub Release 或分支直接安装并跟踪更新。
- **从本地文件/目录安装**：点击 **Add plugin**，选择以下任一路径：
  - 打包好的发行版文件：[`dist/zlib.books-1.2.0.dalibre-plugin`](./dist/zlib.books-1.2.0.dalibre-plugin)
  - 插件目录：[`plugins/zlib`](./plugins/zlib)（或仓库根目录）
- 在弹出的权限确认框中，允许插件访问本地网络（`localhost` / `127.0.0.1`）。

### 使用方式

1. 确保本地 Bridge 处于运行状态（`status` 显示 `RUNNING`）。
2. 在 Dalibre 左侧边栏点击 **Get books**，顶部书源切换为 **Z-Library**：
   - 搜索框为空时可切换浏览 **Most popular**、**Recommended**、**Favorites**。
   - 输入关键词可按 **Format**（`EPUB` / `PDF` / `MOBI` / `AZW3` 等）、**Language**、**Sort** 过滤检索。
   - 点击右侧下载按钮即可自动下载电子书并导入当前 Calibre 书架。

### 插件设置项（Plugins → Z-Library）

修改设置后无需重启 Bridge 服务，下一次请求立即生效：

| 设置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| **Z-Library Domain** | `""`（空） | 留空默认使用 `zlib` 自身配置的域名（`~/.config/zlib/.env` 或内置默认 `https://z-library.sk`）；也可填入自定义镜像域名（如 `https://z-lib.gd`）进行覆盖。 |
| **Proxy** | `system` | • `system`（默认）：跨平台自动读取当前系统代理（macOS 通过 `scutil --proxy`、Windows 通过注册表 `Internet Settings`、Linux 通过环境变量及 `gsettings`）<br>• `direct`：强制直连，不使用代理<br>• `zlib`：使用 `~/.config/zlib/.env` 中保存的静态代理<br>• `http://host:port`（如 `http://127.0.0.1:1082`）：显式指定代理地址 |
| **Local zlib bridge URL** | `http://localhost:17890` | 本地 Bridge 服务监听地址（建议使用 `localhost` 以命中系统代理绕过列表）。 |

---

## 4. 项目目录结构与开发打包

```text
.
├── package.json               # 跨平台 npm CLI 定义 ("dalibre-zlib-bridge")
├── plugin.json                # 仓库根目录插件清单（供 Dalibre "Install from GitHub" 直接识别）
├── main.js                    # Dalibre Book Source 插件主入口
├── plugins/zlib/              # 完整独立插件目录（含 plugin.json, main.js, bridge.mjs）
├── bridge/server.mjs          # 本地 HTTP Bridge 入口（指向 plugins/zlib/bridge.mjs）
├── dist/
│   └── zlib.books-1.2.0.dalibre-plugin  # 可直接分发的插件安装包
├── scripts/
│   ├── service.sh             # Bridge 启停管理与插件打包脚本
│   ├── test-plugin.mjs        # 插件清单与接口校验脚本
│   └── test-e2e.mjs           # 端到端联调测试脚本
└── .github/workflows/
    └── plugin.yml             # GitHub Actions 自动校验与 Release 打包工作流
```

重新打包 `.dalibre-plugin` 发行包：

```bash
./scripts/service.sh pack
```
