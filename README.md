# Dalibre Z-Library Plugin (`zlib.books`)

English | [简体中文](./README.zh-CN.md)

A **Get books** source for [Dalibre](https://github.com/djyde/dalibre): browse Z-Library's Most popular, Recommended and Favorites, search by format, language and sort order, and download books straight into your library. It runs the [zlib CLI (`heartleo/zlib`)](https://github.com/heartleo/zlib), which Dalibre gets for you. Works on macOS, Linux and Windows.

Needs Dalibre 0.6.0 or later.

## Install

In Dalibre, open **Plugins › Add plugin › From GitHub…** and enter `guesq/dalibre-zlib`.

The install dialog asks to run zlib on your computer. It's ready to use as is: Dalibre downloads zlib, checked against the build this plugin names, and keeps it for this plugin alone. If Homebrew or winget already installed zlib, Dalibre uses that one. The menu also offers to install it with them, or to use a zlib file you have.

## Sign in

Open **Plugins › Z-Library** and fill in **Email** and **Password**. The plugin signs in with zlib the next time it loads. The password is kept in your system's keychain.

If you already signed in with `zlib login` in a terminal, leave them empty.

## Settings

| Setting | |
| :-- | :-- |
| **Email**, **Password** | Your Z-Library account. |
| **Domain** | A Z-Library mirror, such as `https://z-lib.gd`. Leave it empty for zlib's own. `zlib doctor` lists the ones reachable from your network. |

Dalibre passes your system's proxy to zlib, so there is nothing to set for it.

## Develop

```sh
npm install -g dalibre-plugin
dalibre-plugin check .                       # validates plugin.json and every platform's zlib build
dalibre-plugin search . "dune"               # runs the plugin as Dalibre would
dalibre-plugin search . "dune" --tool zlib=/path/to/zlib   # with a zlib of your own
```

To update zlib, run `dalibre-plugin tool add . gh:heartleo/zlib@vX.Y.Z --brew heartleo/tap/zlib-cli --winget heartleo.zlib` and bump `version`. Users are asked again before the new build runs.

Pushing a tag such as `v2.0.0` (plugin.json's version) makes a release with the `.dalibre-plugin` package. Dalibre installs and updates from it.
