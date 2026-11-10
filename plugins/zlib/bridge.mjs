#!/usr/bin/env node
import http from "node:http";
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PORT = Number(process.env.ZLIB_BRIDGE_PORT || process.env.PORT || 17890);
const HOST = process.env.ZLIB_BRIDGE_HOST || "127.0.0.1";
const LOG_FILE = path.join(os.tmpdir(), "dalibre-zlib-bridge.log");
const PID_FILE = path.join(os.tmpdir(), `dalibre-zlib-bridge-${PORT}.pid`);

function findZlibBinary() {
  const home = os.homedir();
  const isWin = process.platform === "win32";
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");

  const candidates = isWin
    ? [
        process.env.ZLIB_BIN,
        path.join(localAppData, "Microsoft", "WinGet", "Links", "zlib.exe"),
        path.join(localAppData, "Programs", "zlib", "zlib.exe"),
        path.join(home, "scoop", "shims", "zlib.exe"),
        path.join(home, "go", "bin", "zlib.exe"),
        path.join(home, ".local", "bin", "zlib.exe"),
        "zlib.exe",
      ]
    : [
        process.env.ZLIB_BIN,
        "/opt/homebrew/bin/zlib",
        "/usr/local/bin/zlib",
        "/home/linuxbrew/.linuxbrew/bin/zlib",
        "/usr/bin/zlib",
        path.join(home, ".local", "bin", "zlib"),
        path.join(home, "go", "bin", "zlib"),
        "zlib",
      ];

  for (const bin of candidates.filter(Boolean)) {
    if (bin === "zlib" || bin === "zlib.exe" || fs.existsSync(bin)) {
      return bin;
    }
  }
  return isWin ? "zlib.exe" : "zlib";
}

function findCurlBinary() {
  if (process.platform === "win32") {
    const sys32Curl = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "curl.exe");
    return fs.existsSync(sys32Curl) ? sys32Curl : "curl.exe";
  }
  if (fs.existsSync("/usr/bin/curl")) return "/usr/bin/curl";
  return "curl";
}

const ZLIB_BIN = findZlibBinary();
const CURL_BIN = findCurlBinary();

const ISO_TO_ZLIB_LANG = {
  en: "english",
  eng: "english",
  zh: "chinese",
  zho: "chinese",
  chi: "chinese",
  "zh-cn": "chinese",
  "zh-tw": "chinese",
  ja: "japanese",
  jpn: "japanese",
  fr: "french",
  fra: "french",
  fre: "french",
  de: "german",
  deu: "german",
  ger: "german",
  es: "spanish",
  spa: "spanish",
  ru: "russian",
  rus: "russian",
  it: "italian",
  ita: "italian",
  pt: "portuguese",
  por: "portuguese",
  ko: "korean",
  kor: "korean",
  nl: "dutch",
  nld: "dutch",
  pl: "polish",
  pol: "polish",
  ar: "arabic",
  ara: "arabic",
};

function normalizeLangForZlib(lang) {
  if (!lang) return "";
  const lower = String(lang).trim().toLowerCase();
  return ISO_TO_ZLIB_LANG[lower] || lower;
}

/**
 * Normalizes a proxy string so that whether the input has no scheme ("127.0.0.1:1082"),
 * a single scheme ("http://10.10.10.23"), or duplicated schemes ("http://http://10.10.10.23:7878"),
 * it always returns a clean "<scheme>://<host>:<port>" URL.
 * @param {string} rawHostOrUrl
 * @param {string} [defaultScheme="http"]
 * @param {string} [defaultPort=""]
 */
function normalizeProxyUrl(rawHostOrUrl, defaultScheme = "http", defaultPort = "") {
  let str = String(rawHostOrUrl || "").trim();
  if (!str) return "";

  let scheme = defaultScheme || "http";
  const schemeRegex = /^(https?|socks5h?|socks4a?):\/\//i;
  while (schemeRegex.test(str)) {
    const match = schemeRegex.exec(str);
    if (match && match[1]) {
      scheme = match[1].toLowerCase();
    }
    str = str.slice(match[0].length).trim();
  }

  str = str.replace(/\/+$/, "");
  if (!str) return "";

  const port = String(defaultPort || "").trim();
  if (port && port !== "0" && !/:\d+$/.test(str)) {
    str = `${str}:${port}`;
  }

  return `${scheme}://${str}`;
}

function detectEnvProxy() {
  const raw =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    "";
  return raw ? normalizeProxyUrl(raw, "http") : "";
}

function detectMacSystemProxy() {
  return new Promise((resolve) => {
    const scutilBin = fs.existsSync("/usr/sbin/scutil") ? "/usr/sbin/scutil" : "scutil";
    execFile(scutilBin, ["--proxy"], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) {
        return resolve(detectEnvProxy());
      }
      const getVal = (key) => {
        const m = new RegExp(`\\b${key}\\s*:\\s*([^\\s\\n]+)`).exec(stdout);
        return m ? m[1].trim() : "";
      };
      let proxy = "";
      if (getVal("HTTPEnable") === "1" && getVal("HTTPProxy")) {
        proxy = normalizeProxyUrl(getVal("HTTPProxy"), "http", getVal("HTTPPort"));
      } else if (getVal("HTTPSEnable") === "1" && getVal("HTTPSProxy")) {
        proxy = normalizeProxyUrl(getVal("HTTPSProxy"), "http", getVal("HTTPSPort"));
      } else if (getVal("SOCKSEnable") === "1" && getVal("SOCKSProxy")) {
        proxy = normalizeProxyUrl(getVal("SOCKSProxy"), "socks5", getVal("SOCKSPort"));
      }
      resolve(proxy || detectEnvProxy());
    });
  });
}

function detectWindowsSystemProxy() {
  return new Promise((resolve) => {
    const regKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    execFile("reg", ["query", regKey], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) {
        return resolve(detectEnvProxy());
      }
      const enableMatch = /ProxyEnable\s+REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)/i.exec(stdout);
      const enabled =
        enableMatch && (enableMatch[1] === "0x1" || enableMatch[1] === "1" || Number(enableMatch[1]) === 1);
      if (!enabled) {
        return resolve(detectEnvProxy());
      }
      const serverMatch = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(stdout);
      const rawServer = serverMatch ? serverMatch[1].trim() : "";
      if (!rawServer) {
        return resolve(detectEnvProxy());
      }
      if (rawServer.includes("=")) {
        const parts = Object.fromEntries(
          rawServer
            .split(";")
            .map((s) => s.trim().split("="))
            .filter((kv) => kv.length === 2)
        );
        const picked = parts.http || parts.https || parts.socks;
        const scheme = !parts.http && !parts.https && parts.socks ? "socks5" : "http";
        return resolve(picked ? normalizeProxyUrl(picked, scheme) : detectEnvProxy());
      }
      resolve(normalizeProxyUrl(rawServer, "http") || detectEnvProxy());
    });
  });
}

function detectLinuxSystemProxy() {
  const envProxy = detectEnvProxy();
  if (envProxy) return Promise.resolve(envProxy);

  return new Promise((resolve) => {
    execFile("gsettings", ["get", "org.gnome.system.proxy", "mode"], { timeout: 2500 }, (err, stdout) => {
      if (err || !stdout || !stdout.includes("manual")) {
        return resolve("");
      }
      execFile("gsettings", ["get", "org.gnome.system.proxy.http", "host"], { timeout: 2500 }, (e2, hostOut) => {
        const host = (hostOut || "").replace(/['"\s]/g, "");
        if (e2 || !host) return resolve("");
        execFile("gsettings", ["get", "org.gnome.system.proxy.http", "port"], { timeout: 2500 }, (e3, portOut) => {
          const port = (portOut || "").replace(/[^\d]/g, "");
          if (e3 || !port || port === "0") return resolve("");
          resolve(normalizeProxyUrl(host, "http", port));
        });
      });
    });
  });
}

// Cache system proxy for 5 seconds
let cachedSysProxy = "";
let cachedSysProxyAt = 0;

async function detectSystemProxy() {
  const now = Date.now();
  if (now - cachedSysProxyAt < 5000) {
    return cachedSysProxy;
  }
  let proxy = "";
  if (process.platform === "darwin") {
    proxy = await detectMacSystemProxy();
  } else if (process.platform === "win32") {
    proxy = await detectWindowsSystemProxy();
  } else {
    proxy = await detectLinuxSystemProxy();
  }
  cachedSysProxy = proxy;
  cachedSysProxyAt = now;
  return proxy;
}

/**
 * Resolves the child environment variables for zlib based on requested domain & proxy mode.
 * @param {string} domainSetting
 * @param {string} proxySetting - "system" (default), "direct"/"none", "zlib", or explicit proxy URL
 */
async function buildZlibEnv(domainSetting, proxySetting) {
  const env = { ...process.env };
  const domain = (domainSetting || "").trim();
  if (domain) {
    env.ZLIB_DOMAIN = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
  } else {
    delete env.ZLIB_DOMAIN;
  }

  const mode = (proxySetting || "system").trim();
  const lower = mode.toLowerCase();

  let effectiveProxy = "";
  if (lower === "direct" || lower === "none" || lower === "off") {
    env.ZLIB_PROXY = "";
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    delete env.ALL_PROXY;
    delete env.http_proxy;
    delete env.https_proxy;
    delete env.all_proxy;
    effectiveProxy = "";
  } else if (lower === "zlib") {
    const cfg = await getZlibSavedConfig();
    effectiveProxy = cfg.ZLIB_PROXY ? normalizeProxyUrl(cfg.ZLIB_PROXY, "http") : "";
    if (effectiveProxy) {
      env.ZLIB_PROXY = effectiveProxy;
    } else {
      delete env.ZLIB_PROXY;
    }
  } else if (lower === "system" || lower === "") {
    const sysProxy = await detectSystemProxy();
    env.ZLIB_PROXY = sysProxy;
    effectiveProxy = sysProxy;
  } else {
    const normalized = normalizeProxyUrl(mode, "http");
    env.ZLIB_PROXY = normalized;
    effectiveProxy = normalized;
  }

  return { env, effectiveProxy, effectiveDomain: env.ZLIB_DOMAIN || "" };
}

function runZlib(args, customEnv, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile(
      ZLIB_BIN,
      args,
      {
        env: customEnv || process.env,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const errLines = String(stderr || stdout || err.message || "zlib command failed")
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !/^\d+%\s*\(/.test(l) && !/^Downloading:/i.test(l));
          const msg = errLines.join(" | ") || String(stderr || err.message || "zlib command failed").trim();
          const error = new Error(msg);
          error.stderr = stderr;
          error.stdout = stdout;
          error.code = err.code;
          return reject(error);
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

let cachedConfig = null;
let cachedConfigAt = 0;

async function getZlibSavedConfig() {
  const now = Date.now();
  if (cachedConfig && now - cachedConfigAt < 30_000) {
    return cachedConfig;
  }
  try {
    const { stdout } = await runZlib(["config", "--json"], process.env, 10000);
    const items = JSON.parse(stdout);
    const map = {};
    for (const item of items) {
      if (item && item.key) {
        if (item.key === "ZLIB_PROXY") {
          map[item.key] = item.saved ? normalizeProxyUrl(item.saved, "http") : "";
        } else {
          map[item.key] = item.saved || item.value;
        }
      }
    }
    cachedConfig = map;
    cachedConfigAt = now;
    return map;
  } catch {
    return cachedConfig || {};
  }
}

/**
 * Calls `zlib mcp` over stdio to execute a single tool call such as `get_book`.
 */
function callZlibMcpTool(toolName, toolArgs, customEnv, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ZLIB_BIN, ["mcp"], {
      env: customEnv || process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`MCP tool ${toolName} timed out`));
      }
    }, timeoutMs);

    function finish(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      if (err) reject(err);
      else resolve(result);
    }

    child.on("error", (err) => finish(err));

    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            child.stdin.write(
              JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
            );
            child.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: toolName, arguments: toolArgs },
              }) + "\n"
            );
          } else if (msg.id === 2) {
            if (msg.error) {
              return finish(new Error(msg.error.message || "MCP error"));
            }
            const res = msg.result || {};
            if (res.isError) {
              const text = res.content?.[0]?.text || "MCP tool returned error";
              return finish(new Error(text));
            }
            if (res.structuredContent) {
              return finish(null, res.structuredContent);
            }
            const text = res.content?.[0]?.text;
            if (text) {
              try {
                return finish(null, JSON.parse(text));
              } catch {
                return finish(null, { raw: text });
              }
            }
            return finish(null, res);
          }
        } catch {}
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        finish(new Error(stderrBuf.trim() || `zlib mcp exited with code ${code}`));
      }
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "dalibre-zlib-bridge", version: "1.2.0" },
        },
      }) + "\n"
    );
  });
}

// LRU cover cache in memory (max 200 images)
const coverCache = new Map();
const MAX_COVER_CACHE = 200;

function cacheCover(url, contentType, buffer) {
  if (coverCache.size >= MAX_COVER_CACHE) {
    const oldestKey = coverCache.keys().next().value;
    if (oldestKey) coverCache.delete(oldestKey);
  }
  coverCache.set(url, { contentType, buffer, at: Date.now() });
}

function sniffImageContentType(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (
    buf.length > 12 &&
    buf.subarray(0, 4).toString() === "RIFF" &&
    buf.subarray(8, 12).toString() === "WEBP"
  ) {
    return "image/webp";
  }
  return "image/jpeg";
}

function runCurlCover(targetUrl, proxyUrl, timeoutSec = 8) {
  return new Promise((resolve, reject) => {
    const args = ["-fsSL", "--max-time", String(timeoutSec)];
    if (proxyUrl) {
      args.push("-x", proxyUrl);
    }
    args.push(targetUrl);

    execFile(
      CURL_BIN,
      args,
      {
        encoding: "buffer",
        maxBuffer: 10 * 1024 * 1024,
        timeout: (timeoutSec + 1) * 1000,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err || !stdout || stdout.length === 0) {
          return reject(
            new Error(stderr ? stderr.toString().trim() : err?.message || "Failed to fetch cover")
          );
        }
        resolve({ buffer: stdout, contentType: sniffImageContentType(stdout) });
      }
    );
  });
}

async function runNativeFetchCover(targetUrl, timeoutSec = 8) {
  const res = await fetch(targetUrl, { signal: AbortSignal.timeout(timeoutSec * 1000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const arr = await res.arrayBuffer();
  const buffer = Buffer.from(arr);
  if (buffer.length === 0) throw new Error("Empty image buffer");
  return { buffer, contentType: sniffImageContentType(buffer) };
}

async function fetchCoverBuffer(targetUrl, proxyUrl) {
  const attempts = [];
  if (proxyUrl) {
    attempts.push(runCurlCover(targetUrl, proxyUrl, 10));
  }
  attempts.push(runCurlCover(targetUrl, "", 8));
  attempts.push(runNativeFetchCover(targetUrl, 8));
  return Promise.any(attempts);
}

// Short-lived prepared downloads store: token -> { filePath, fileName, size, tmpDir, createdAt }
const preparedDownloads = new Map();

function cleanupPrepared(token) {
  const entry = preparedDownloads.get(token);
  if (!entry) return;
  preparedDownloads.delete(token);
  try {
    fs.rmSync(entry.tmpDir, { recursive: true, force: true });
  } catch {}
}

function classifyZlibError(err) {
  const msg = String(err?.message || err || "Unknown error");
  const lower = msg.toLowerCase();
  if (
    lower.includes("not logged in") ||
    lower.includes("login") ||
    lower.includes("unauthorized") ||
    lower.includes("401") ||
    lower.includes("remix_userkey")
  ) {
    return { status: 401, kind: "auth", message: msg };
  }
  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("daily_remaining") ||
    lower.includes("quota") ||
    lower.includes("limit")
  ) {
    return { status: 429, kind: "rateLimited", message: msg };
  }
  if (lower.includes("not found") || lower.includes("404")) {
    return { status: 404, kind: "notFound", message: msg };
  }
  return { status: 502, kind: "unavailable", message: msg };
}

function decorateBooks(books, baseOrigin, proxyParam, domainParam) {
  if (!Array.isArray(books)) return [];
  const extraQuery =
    (proxyParam ? `&proxy=${encodeURIComponent(proxyParam)}` : "") +
    (domainParam ? `&domain=${encodeURIComponent(domainParam)}` : "");

  return books.map((b) => {
    const rawCover = b.cover && /^https?:\/\//i.test(b.cover) ? b.cover : "";
    return {
      ...b,
      cover_raw: rawCover,
      cover: rawCover
        ? `${baseOrigin}/cover?url=${encodeURIComponent(rawCover)}${extraQuery}`
        : "",
      download_proxy: b.id
        ? `${baseOrigin}/download?id=${encodeURIComponent(b.id)}${extraQuery}`
        : "",
    };
  });
}

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function startServer() {
  setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of preparedDownloads.entries()) {
      if (now - entry.createdAt > 10 * 60 * 1000) {
        cleanupPrepared(token);
      }
    }
  }, 60_000).unref();

  const server = http.createServer(async (req, res) => {
    const hostHeader = req.headers.host || `localhost:${PORT}`;
    const baseOrigin = `http://${hostHeader}`;
    const reqUrl = new URL(req.url || "/", baseOrigin);
    const pathname = reqUrl.pathname;

    const domainParam = (reqUrl.searchParams.get("domain") || "").trim();
    const proxyParam = (reqUrl.searchParams.get("proxy") || "system").trim();

    try {
      const { env: zlibEnv, effectiveProxy } = await buildZlibEnv(domainParam, proxyParam);

      if (pathname === "/health") {
        const saved = await getZlibSavedConfig();
        const sysProxy = await detectSystemProxy();
        return sendJSON(res, 200, {
          ok: true,
          pid: process.pid,
          platform: process.platform,
          zlibBin: ZLIB_BIN,
          savedDomain: saved.ZLIB_DOMAIN || "",
          savedProxy: saved.ZLIB_PROXY || "",
          systemProxy: sysProxy,
          macSystemProxy: sysProxy,
          effectiveProxy,
        });
      }

      if (pathname === "/shutdown" && req.method === "POST") {
        const remote = req.socket?.remoteAddress || "";
        if (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") {
          sendJSON(res, 200, { ok: true, pid: process.pid });
          setTimeout(() => {
            try {
              fs.rmSync(PID_FILE, { force: true });
            } catch {}
            server.close(() => process.exit(0));
            setTimeout(() => process.exit(0), 300).unref();
          }, 50);
          return;
        }
        return sendJSON(res, 403, { error: "Forbidden", kind: "invalid" });
      }

      if (pathname === "/search") {
        const q = (reqUrl.searchParams.get("q") || "").trim();
        const page = Math.max(1, parseInt(reqUrl.searchParams.get("page") || "1", 10) || 1);
        const count = Math.min(
          50,
          Math.max(1, parseInt(reqUrl.searchParams.get("count") || "25", 10) || 25)
        );
        const ext = (reqUrl.searchParams.get("ext") || "").trim().toLowerCase();
        const lang = normalizeLangForZlib(reqUrl.searchParams.get("lang") || "");
        const order = (reqUrl.searchParams.get("order") || "").trim();

        if (!q) {
          return sendJSON(res, 200, { books: [], page: 1, total_pages: 0 });
        }

        const args = ["search", q, "--json", "-p", String(page), "-n", String(count)];
        if (ext) args.push("--ext", ext);
        if (lang) args.push("--language", lang);
        if (order) args.push("--order", order);

        const { stdout } = await runZlib(args, zlibEnv);
        const parsed = JSON.parse(stdout);
        const books = Array.isArray(parsed) ? parsed : parsed.books || [];
        const totalPages = parsed.total_pages ?? (books.length > 0 ? page : 0);

        return sendJSON(res, 200, {
          books: decorateBooks(books, baseOrigin, proxyParam, domainParam),
          page: parsed.page || page,
          total_pages: totalPages,
        });
      }

      if (pathname === "/collection") {
        const id = (reqUrl.searchParams.get("id") || "popular").trim();
        const page = Math.max(1, parseInt(reqUrl.searchParams.get("page") || "1", 10) || 1);
        const ext = (reqUrl.searchParams.get("ext") || "").trim().toLowerCase();
        const lang = normalizeLangForZlib(reqUrl.searchParams.get("lang") || "");

        let args;
        if (id === "favorites") {
          args = ["favorites", "-p", String(page), "--json"];
        } else if (id === "recommended") {
          if (page > 1) {
            return sendJSON(res, 200, { books: [], page, total_pages: 1 });
          }
          args = ["recommended", "--json"];
        } else {
          if (page > 1) {
            return sendJSON(res, 200, { books: [], page, total_pages: 1 });
          }
          args = ["most-popular", "--json"];
        }

        const { stdout } = await runZlib(args, zlibEnv);
        const parsed = JSON.parse(stdout);
        let books = Array.isArray(parsed) ? parsed : parsed.books || [];
        const totalPages = parsed.total_pages || 1;

        if (ext) {
          books = books.filter((b) => String(b.extension || "").toLowerCase() === ext);
        }
        if (lang) {
          books = books.filter((b) => String(b.language || "").toLowerCase() === lang);
        }

        return sendJSON(res, 200, {
          books: decorateBooks(books, baseOrigin, proxyParam, domainParam),
          page: parsed.page || page,
          total_pages: totalPages,
        });
      }

      if (pathname === "/book") {
        const id = (reqUrl.searchParams.get("id") || "").trim();
        if (!id) {
          return sendJSON(res, 400, { error: "Missing book id", kind: "invalid" });
        }
        const details = await callZlibMcpTool("get_book", { id }, zlibEnv);
        return sendJSON(res, 200, details);
      }

      if (pathname === "/cover") {
        const targetUrl = (reqUrl.searchParams.get("url") || "").trim();
        if (!/^https?:\/\//i.test(targetUrl)) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          return res.end("Invalid cover URL");
        }

        const hit = coverCache.get(targetUrl);
        if (hit) {
          res.writeHead(200, {
            "Content-Type": hit.contentType,
            "Content-Length": hit.buffer.length,
            "Cache-Control": "public, max-age=86400",
          });
          return res.end(hit.buffer);
        }

        const { buffer, contentType } = await fetchCoverBuffer(targetUrl, effectiveProxy);
        cacheCover(targetUrl, contentType, buffer);

        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": buffer.length,
          "Cache-Control": "public, max-age=86400",
        });
        return res.end(buffer);
      }

      // Phase 1 of 2-phase download: called by resolve(item, format) in main.js
      if (pathname === "/prepare") {
        const id = (reqUrl.searchParams.get("id") || "").trim();
        if (!id) {
          return sendJSON(res, 400, { error: "Missing book id", kind: "invalid" });
        }

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dalibre-zlib-"));
        try {
          console.log(
            `[zlib-bridge] Downloading book ${id} (proxy: ${effectiveProxy || "direct"}, domain: ${
              zlibEnv.ZLIB_DOMAIN || "default"
            })...`
          );
          const { stdout } = await runZlib(["download", id, "-d", tmpDir, "--json"], zlibEnv, 180000);
          const dlInfo = JSON.parse(stdout);
          const filePath = dlInfo.path;
          if (!filePath || !fs.existsSync(filePath)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            return sendJSON(res, 404, { error: "Downloaded file not found", kind: "notFound" });
          }

          const stat = fs.statSync(filePath);
          const fileName = path.basename(filePath);
          const token = crypto.randomBytes(16).toString("hex");
          preparedDownloads.set(token, {
            filePath,
            fileName,
            size: stat.size,
            tmpDir,
            createdAt: Date.now(),
          });
          console.log(`[zlib-bridge] Prepared ${fileName} (${stat.size} bytes) -> token ${token}`);
          return sendJSON(res, 200, {
            ok: true,
            token,
            filename: fileName,
            size: stat.size,
          });
        } catch (err) {
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch {}
          throw err;
        }
      }

      // Phase 2 of 2-phase download: streams the prepared file immediately to Dalibre
      if (pathname === "/file") {
        const token = (reqUrl.searchParams.get("token") || "").trim();
        const entry = preparedDownloads.get(token);
        if (!entry || !fs.existsSync(entry.filePath)) {
          cleanupPrepared(token);
          return sendJSON(res, 404, { error: "Prepared file expired or not found", kind: "notFound" });
        }

        const asciiName = entry.fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": entry.size,
          "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(
            entry.fileName
          )}`,
        });

        const stream = fs.createReadStream(entry.filePath);
        stream.on("error", () => {
          cleanupPrepared(token);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
        res.on("close", () => cleanupPrepared(token));
        stream.pipe(res);
        return;
      }

      // Direct 1-phase fallback download
      if (pathname === "/download") {
        const id = (reqUrl.searchParams.get("id") || "").trim();
        if (!id) {
          return sendJSON(res, 400, { error: "Missing book id", kind: "invalid" });
        }

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dalibre-zlib-"));
        const cleanup = () => {
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch {}
        };

        try {
          const { stdout } = await runZlib(["download", id, "-d", tmpDir, "--json"], zlibEnv, 180000);
          const dlInfo = JSON.parse(stdout);
          const filePath = dlInfo.path;
          if (!filePath || !fs.existsSync(filePath)) {
            cleanup();
            return sendJSON(res, 404, { error: "Downloaded file not found", kind: "notFound" });
          }

          const stat = fs.statSync(filePath);
          const fileName = path.basename(filePath);
          const asciiName = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");

          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": stat.size,
            "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(
              fileName
            )}`,
          });

          const stream = fs.createReadStream(filePath);
          stream.on("error", () => {
            cleanup();
            if (!res.headersSent) res.writeHead(500);
            res.end();
          });
          res.on("close", cleanup);
          stream.pipe(res);
          return;
        } catch (err) {
          cleanup();
          throw err;
        }
      }

      return sendJSON(res, 404, { error: `Unknown endpoint ${pathname}`, kind: "notFound" });
    } catch (err) {
      const info = classifyZlibError(err);
      console.error(`[zlib-bridge] ${req.method} ${req.url} -> ${info.status}: ${info.message}`);
      return sendJSON(res, info.status, { error: info.message, kind: info.kind });
    }
  });

  const removePidFile = () => {
    try {
      fs.rmSync(PID_FILE, { force: true });
    } catch {}
  };
  process.on("exit", removePidFile);
  process.on("SIGINT", () => {
    removePidFile();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    removePidFile();
    process.exit(0);
  });

  server.listen(PORT, HOST, () => {
    try {
      fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
    } catch {}
    console.log(`[zlib-bridge] Listening on http://localhost:${PORT} (${HOST}:${PORT}, using ${ZLIB_BIN})`);
  });
}

// ============================================================================
// Cross-Platform CLI Management Commands
// ============================================================================

async function checkBridgeHealth(timeoutMs = 1200) {
  try {
    const res = await fetch(`http://localhost:${PORT}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function cliStart() {
  const existing = await checkBridgeHealth();
  if (existing) {
    console.log(
      `zlib-bridge is already running on http://localhost:${PORT} (PID: ${existing.pid || "unknown"})`
    );
    return;
  }

  const outFd = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [__filename, "serve"], {
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env: process.env,
    windowsHide: true,
  });
  child.unref();
  try {
    fs.closeSync(outFd);
  } catch {}

  for (let i = 0; i < 15; i++) {
    await sleep(150);
    const health = await checkBridgeHealth(800);
    if (health) {
      console.log(
        `Started zlib-bridge on http://localhost:${PORT} (PID: ${health.pid || child.pid}, log: ${LOG_FILE})`
      );
      return;
    }
  }
  console.log(`Started zlib-bridge process (PID: ${child.pid}, log: ${LOG_FILE})`);
}

async function cliStop() {
  let stoppedPid = null;

  // 1. Try clean loopback HTTP /shutdown (works on macOS, Linux, Windows)
  try {
    const res = await fetch(`http://localhost:${PORT}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      stoppedPid = data.pid || "via /shutdown";
    }
  } catch {}

  // 2. Fallback to PID file if still present
  if (fs.existsSync(PID_FILE)) {
    try {
      const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
      if (pid > 0) {
        process.kill(pid, "SIGTERM");
        stoppedPid = stoppedPid || pid;
      }
    } catch {}
    try {
      fs.rmSync(PID_FILE, { force: true });
    } catch {}
  }

  // 3. Fallback to lsof on macOS/Linux for older bridge instances without /shutdown
  if (!stoppedPid && process.platform !== "win32") {
    try {
      const lsofBin = fs.existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
      const out = execFileSync(lsofBin, [`-iTCP:${PORT}`, "-sTCP:LISTEN", "-t"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) {
        for (const p of out.split(/\s+/)) {
          const pid = Number(p);
          if (pid > 0) {
            try {
              process.kill(pid, "SIGTERM");
              stoppedPid = pid;
            } catch {}
          }
        }
      }
    } catch {}
  }

  if (stoppedPid) {
    for (let i = 0; i < 10; i++) {
      await sleep(120);
      if (!(await checkBridgeHealth(400))) break;
    }
    console.log(`Stopped zlib-bridge (PID: ${stoppedPid})`);
  } else {
    console.log(`zlib-bridge is not running on port ${PORT}`);
  }
}

async function cliStatus() {
  const health = await checkBridgeHealth(1500);
  if (health) {
    console.log(
      `zlib-bridge is RUNNING on http://localhost:${PORT} (PID: ${health.pid || "unknown"}, platform: ${
        health.platform || process.platform
      })`
    );
    console.log(JSON.stringify(health));
  } else {
    console.log("zlib-bridge is STOPPED");
  }
}

function getServicePaths() {
  const home = os.homedir();
  return {
    darwinPlist: path.join(home, "Library", "LaunchAgents", "com.dalibre.zlib-bridge.plist"),
    linuxService: path.join(home, ".config", "systemd", "user", "dalibre-zlib-bridge.service"),
    winStartupVbs: path.join(
      process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      "dalibre-zlib-bridge.vbs"
    ),
  };
}

async function cliInstallService() {
  const paths = getServicePaths();
  await cliStop();

  if (process.platform === "darwin") {
    fs.mkdirSync(path.dirname(paths.darwinPlist), { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.dalibre.zlib-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${__filename}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>ZLIB_BRIDGE_PORT</key>
    <string>${PORT}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
</dict>
</plist>
`;
    fs.writeFileSync(paths.darwinPlist, plist, "utf8");
    try {
      execFileSync("launchctl", ["unload", paths.darwinPlist], { stdio: "ignore" });
    } catch {}
    execFileSync("launchctl", ["load", paths.darwinPlist], { stdio: "inherit" });
    console.log(`Installed and started macOS LaunchAgent: ${paths.darwinPlist}`);
  } else if (process.platform === "linux") {
    fs.mkdirSync(path.dirname(paths.linuxService), { recursive: true });
    const unit = `[Unit]
Description=Dalibre Z-Library Local HTTP Bridge
After=network.target

[Service]
Type=simple
Environment="PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin:${path.join(
      os.homedir(),
      ".local",
      "bin"
    )}"
Environment="ZLIB_BRIDGE_PORT=${PORT}"
ExecStart="${process.execPath}" "${__filename}" serve
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
    fs.writeFileSync(paths.linuxService, unit, "utf8");
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", "dalibre-zlib-bridge.service"], {
      stdio: "inherit",
    });
    console.log(`Installed and started Linux systemd user service: ${paths.linuxService}`);
  } else if (process.platform === "win32") {
    fs.mkdirSync(path.dirname(paths.winStartupVbs), { recursive: true });
    const escapedNode = process.execPath.replace(/"/g, '""');
    const escapedScript = __filename.replace(/"/g, '""');
    const vbs = `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${escapedNode}"" ""${escapedScript}"" start", 0, False\r\n`;
    fs.writeFileSync(paths.winStartupVbs, vbs, "utf8");
    await cliStart();
    console.log(`Installed Windows login startup script: ${paths.winStartupVbs}`);
  } else {
    throw new Error(`Unsupported platform for auto-start service: ${process.platform}`);
  }
}

async function cliUninstallService() {
  const paths = getServicePaths();
  if (process.platform === "darwin") {
    if (fs.existsSync(paths.darwinPlist)) {
      try {
        execFileSync("launchctl", ["unload", paths.darwinPlist], { stdio: "ignore" });
      } catch {}
      fs.rmSync(paths.darwinPlist, { force: true });
      console.log(`Removed macOS LaunchAgent: ${paths.darwinPlist}`);
    } else {
      console.log("macOS LaunchAgent is not installed.");
    }
  } else if (process.platform === "linux") {
    if (fs.existsSync(paths.linuxService)) {
      try {
        execFileSync("systemctl", ["--user", "disable", "--now", "dalibre-zlib-bridge.service"], {
          stdio: "ignore",
        });
      } catch {}
      fs.rmSync(paths.linuxService, { force: true });
      try {
        execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      } catch {}
      console.log(`Removed Linux systemd user service: ${paths.linuxService}`);
    } else {
      console.log("Linux systemd user service is not installed.");
    }
  } else if (process.platform === "win32") {
    if (fs.existsSync(paths.winStartupVbs)) {
      fs.rmSync(paths.winStartupVbs, { force: true });
      console.log(`Removed Windows login startup script: ${paths.winStartupVbs}`);
    } else {
      console.log("Windows login startup script is not installed.");
    }
  }
  await cliStop();
}

function printHelp(useTty = false) {
  const helpText = `
dalibre-zlib-bridge - Local Z-Library CLI HTTP bridge for Dalibre

Usage:
  dalibre-zlib-bridge <command>

Commands:
  start              Start the bridge service in the background
  stop               Stop the running background bridge service
  restart            Restart the background bridge service
  status             Show service status and detected proxy/domain settings
  install-service    Register and start login auto-start service (LaunchAgent / systemd / Startup)
  uninstall-service  Remove login auto-start service and stop the bridge
  serve              Run the HTTP bridge server in the foreground
  help, --help, -h   Show this help message
`;
  if (useTty) {
    const ttyPath = process.platform === "win32" ? "CON" : "/dev/tty";
    try {
      const fd = fs.openSync(ttyPath, "w");
      fs.writeSync(fd, helpText + "\n");
      fs.closeSync(fd);
      return;
    } catch {}
  }
  console.log(helpText.trim());
}

const rawArg = (process.argv[2] || "").trim().toLowerCase();
const subcommand = rawArg || (process.stdout.isTTY ? "help" : "serve");

switch (subcommand) {
  case "serve":
    startServer();
    break;
  case "start":
    await cliStart();
    break;
  case "stop":
    await cliStop();
    break;
  case "restart":
    await cliStop();
    await cliStart();
    break;
  case "status":
    await cliStatus();
    break;
  case "install-service":
    await cliInstallService();
    break;
  case "uninstall-service":
    await cliUninstallService();
    break;
  case "postinstall":
    printHelp(true);
    break;
  case "help":
  case "--help":
  case "-h":
    printHelp(false);
    break;
  default:
    printHelp(false);
    process.exit(1);
}
