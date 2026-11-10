#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.ZLIB_BRIDGE_PORT || "17891";

const bridge = spawn(process.execPath, [path.join(ROOT, "plugins", "zlib", "bridge.mjs")], {
  env: { ...process.env, ZLIB_BRIDGE_PORT: PORT },
  stdio: ["ignore", "pipe", "pipe"],
});

bridge.stderr.on("data", (d) => process.stderr.write(d));

function cleanup(code = 0) {
  try {
    bridge.kill("SIGTERM");
  } catch {}
  process.exit(code);
}

bridge.stdout.on("data", (d) => {
  const line = d.toString();
  process.stdout.write(line);
  if (line.includes("Listening on")) {
    const tester = spawn(
      process.execPath,
      [path.join(ROOT, "scripts", "test-plugin.mjs"), "--live", "golang"],
      {
        env: { ...process.env, ZLIB_BRIDGE_URL: `http://localhost:${PORT}` },
        stdio: "inherit",
      }
    );
    tester.on("close", (code) => cleanup(code ?? 1));
  }
});

bridge.on("error", (err) => {
  console.error("Failed to start bridge:", err);
  cleanup(1);
});
