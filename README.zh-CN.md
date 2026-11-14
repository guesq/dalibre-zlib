# Dalibre Z-Library 插件 (`zlib.books`)

[English](./README.md) | 简体中文

[Dalibre](https://github.com/djyde/dalibre) 的 **Get books** 书源：浏览 Z-Library 的热门、推荐和收藏，按格式、语言、排序搜索，直接下载到书库。它通过 [zlib CLI (`heartleo/zlib`)](https://github.com/heartleo/zlib) 工作，zlib 由 Dalibre 替你获取。支持 macOS、Linux 和 Windows。

需要 Dalibre 0.6.0 或更新版本。

## 安装

在 Dalibre 中打开 **插件 › 添加插件 › 从 GitHub…**，输入 `guesq/dalibre-zlib`。

安装对话框会请求在你的电脑上运行 zlib，保持默认即可：Dalibre 会下载 zlib，按插件声明的版本校验后只给这个插件使用。如果 Homebrew 或 winget 已经装了 zlib，就直接用那个；菜单里也可以改为用它们安装，或者选择你已有的 zlib 文件。

## 登录

打开 **插件 › Z-Library**，填写 **Email** 和 **Password**，插件下次加载时会用 zlib 登录。密码保存在系统钥匙串里。

如果你已经在终端用 `zlib login` 登录过，这两项留空即可。

## 设置

| 设置 | |
| :-- | :-- |
| **Email**、**Password** | 你的 Z-Library 账号。 |
| **Domain** | Z-Library 镜像，如 `https://z-lib.gd`。留空则用 zlib 自己的。`zlib doctor` 会列出你的网络能访问的域名。 |

Dalibre 会把系统代理传给 zlib，不需要另外设置。
