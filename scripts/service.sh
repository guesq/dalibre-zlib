#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$ROOT_DIR/plugins/zlib"
BRIDGE_SCRIPT="$PLUGIN_DIR/bridge.mjs"
NODE_BIN="$(command -v node || echo "/opt/homebrew/bin/node")"

cmd="${1:-start}"

case "$cmd" in
  start|stop|restart|status|serve|install-service|uninstall-service)
    exec "$NODE_BIN" "$BRIDGE_SCRIPT" "$cmd"
    ;;
  install-agent)
    exec "$NODE_BIN" "$BRIDGE_SCRIPT" install-service
    ;;
  uninstall-agent)
    exec "$NODE_BIN" "$BRIDGE_SCRIPT" uninstall-service
    ;;
  pack)
    mkdir -p "$ROOT_DIR/dist"
    VERSION="$( "$NODE_BIN" -p "require('$PLUGIN_DIR/plugin.json').version" )"
    OUT="$ROOT_DIR/dist/zlib.books-${VERSION}.dalibre-plugin"
    rm -f "$ROOT_DIR/dist/"*.dalibre-plugin
    cp "$PLUGIN_DIR/main.js" "$ROOT_DIR/main.js"
    (cd "$PLUGIN_DIR" && zip -r "$OUT" plugin.json main.js bridge.mjs dalibre.d.ts jsconfig.json)
    echo "Packed plugin archive: $OUT"
    ;;
  *)
    echo "Usage: $0 [start|stop|restart|status|install-service|uninstall-service|pack]"
    exit 1
    ;;
esac
