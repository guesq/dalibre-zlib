# Dalibre Z-Library Plugin (`zlib.books`)

English | [简体中文](./README.zh-CN.md)

A cross-platform **Get Books** book-source plugin for [Dalibre](https://github.com/djyde/dalibre) powered by the local [zlib CLI (`heartleo/zlib`)](https://github.com/heartleo/zlib). Browse Z-Library's **Most Popular**, **Recommended**, and **Favorites** lists, search by format/language/sort order, preview book covers, and download books directly into your Calibre library on **macOS, Linux, and Windows**.

---

## 1. Prerequisites: Install & Configure `zlib` CLI

This plugin requires [`heartleo/zlib`](https://github.com/heartleo/zlib) and **Node.js (`>= 18`)**.

### Install `zlib` CLI

- **macOS / Linux (Homebrew)**:
  ```bash
  brew install heartleo/tap/zlib
  ```
- **Linux / macOS (Install Script)**:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/heartleo/zlib/main/install.sh | sh
  ```
- **Windows (WinGet)**:
  ```powershell
  winget install --id heartleo.zlib --exact
  ```
- **Any Platform (via Go `>= 1.25`)**:
  ```bash
  go install github.com/heartleo/zlib/cmd/zlib@latest
  ```

### Sign In to Z-Library

```bash
# 1. Sign in to your Z-Library account (credentials are saved in ~/.config/zlib/.env)
zlib login

# 2. Verify your account status and daily download quota
zlib profile
```

---

## 2. Install & Run the Local Bridge Service

Because Dalibre plugins run inside a sandboxed QuickJS environment (without direct access to local binaries or dynamic third-party download CDN domains), this plugin communicates with a lightweight cross-platform HTTP bridge (`http://localhost:17890` by default) that wraps the `zlib` CLI.

You can run or install the bridge in **any of the following 3 ways**:

### Option A: Run from the Cloned Repository

```bash
# macOS / Linux
./scripts/service.sh          # Start background service (default action is 'start')
./scripts/service.sh status   # Check status & detected OS proxy/domain
./scripts/service.sh stop     # Stop background service

# Cross-platform (Windows / macOS / Linux)
node plugins/zlib/bridge.mjs start
node plugins/zlib/bridge.mjs status
node plugins/zlib/bridge.mjs stop
```

### Option B: Install as a Global CLI via `npm` (Cross-Platform)

```bash
# Install globally from GitHub
npm install -g github:guesq/dalibre-zlib

# Then run from anywhere on macOS, Linux, or Windows:
dalibre-zlib-bridge start
dalibre-zlib-bridge status
dalibre-zlib-bridge stop
```

### Option C: Run Directly from Dalibre's Installed Plugin Folder (Zero Extra Download)

Because `bridge.mjs` is bundled inside `zlib.books-*.dalibre-plugin`, once you install the plugin inside Dalibre (via **Install from GitHub** or **Add plugin**), you can run it directly from Dalibre's plugin directory without cloning this repository:

- **macOS**:
  ```bash
  node "$HOME/Library/Application Support/Dalibre/plugins/zlib.books/bridge.mjs" start
  ```
- **Linux**:
  ```bash
  node "$HOME/.config/Dalibre/plugins/zlib.books/bridge.mjs" start
  ```
- **Windows (PowerShell)**:
  ```powershell
  node "$env:APPDATA\Dalibre\plugins\zlib.books\bridge.mjs" start
  ```

---

### Optional: Enable System Login Auto-Start (`install-service`)

If you prefer the bridge to start automatically in the background whenever you log in to your computer:

```bash
# Using repo script, global CLI, or node bridge.mjs directly:
./scripts/service.sh install-service
# (or: dalibre-zlib-bridge install-service)

# To remove auto-start and stop the service:
./scripts/service.sh uninstall-service
# (or: dalibre-zlib-bridge uninstall-service)
```

What `install-service` sets up per OS:
- **macOS**: User `LaunchAgent` at `~/Library/LaunchAgents/com.dalibre.zlib-bridge.plist` (`launchctl`).
- **Linux**: User `systemd` service at `~/.config/systemd/user/dalibre-zlib-bridge.service` (`systemctl --user`).
- **Windows**: User login startup script at `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dalibre-zlib-bridge.vbs`.

---

## 3. Install & Use the Plugin in Dalibre

### Installation

Open **Dalibre** → **Plugins**:

- **Install from GitHub**: Click **Install from GitHub** and enter `guesq/dalibre-zlib` (or `https://github.com/guesq/dalibre-zlib`) to install from a GitHub Release or branch and track updates.
- **Install from Local File / Folder**: Click **Add plugin** and select either:
  - The packaged release archive: [`dist/zlib.books-1.2.0.dalibre-plugin`](./dist/zlib.books-1.2.0.dalibre-plugin)
  - The plugin directory: [`plugins/zlib`](./plugins/zlib) (or the repository root)
- When prompted, allow the plugin to access your local network (`localhost` / `127.0.0.1`).

### Usage

1. Ensure the local bridge is running (`status` shows `RUNNING`).
2. In Dalibre's left sidebar, open **Get books** and select **Z-Library** as the source:
   - Leave the search box empty to browse **Most popular**, **Recommended**, and **Favorites**.
   - Enter keywords and filter by **Format** (`EPUB`, `PDF`, `MOBI`, `AZW3`, etc.), **Language**, or **Sort**.
   - Click the download button on any book to download it via `zlib` and automatically import it into your Calibre library.

### Plugin Settings (Plugins → Z-Library)

Changes take effect immediately on the next request without restarting the bridge:

| Setting | Default | Description |
| :--- | :--- | :--- |
| **Z-Library Domain** | `""` (empty) | Leave empty to use the domain configured in `zlib` (`~/.config/zlib/.env` or built-in default `https://z-library.sk`), or enter a custom mirror domain (e.g. `https://z-lib.gd`). |
| **Proxy** | `system` | • `system` (default): Auto-detect OS system proxy (`scutil --proxy` on macOS, Registry `Internet Settings` on Windows, `HTTPS_PROXY`/`HTTP_PROXY` + `gsettings` on Linux)<br>• `direct`: Connect directly without any proxy<br>• `zlib`: Use the static proxy saved in `~/.config/zlib/.env`<br>• `http://host:port` (e.g. `http://127.0.0.1:1082`): Use an explicit proxy URL |
| **Local zlib bridge URL** | `http://localhost:17890` | URL of the local bridge service (use `localhost` so OS system proxy `ExceptionsList` bypasses local traffic). |

---

## 4. Repository Structure & Packaging

```text
.
├── package.json               # Cross-platform npm CLI definition ("dalibre-zlib-bridge")
├── plugin.json                # Root plugin manifest (for Dalibre "Install from GitHub")
├── main.js                    # Dalibre Book Source entry module
├── plugins/zlib/              # Self-contained plugin directory (plugin.json, main.js, bridge.mjs)
├── bridge/server.mjs          # Local HTTP bridge entry point
├── dist/
│   └── zlib.books-1.2.0.dalibre-plugin  # Distributable plugin package
├── scripts/
│   ├── service.sh             # Bridge service wrapper & plugin packager
│   ├── test-plugin.mjs        # Manifest & contract validation script
│   └── test-e2e.mjs           # End-to-end integration test script
└── .github/workflows/
    └── plugin.yml             # GitHub Actions workflow for validation & release packaging
```

To rebuild the `.dalibre-plugin` archive:

```bash
./scripts/service.sh pack
```
