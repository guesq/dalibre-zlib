#!/usr/bin/env node
/**
 * Validates plugins/zlib/plugin.json and plugins/zlib/main.js against Dalibre's
 * Plugin API v1 contract, and optionally runs live end-to-end tests against bridge/server.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PLUGIN_DIR = path.join(ROOT, "plugins", "zlib");

const VALID_FORMATS = new Set([
  "EPUB", "KEPUB", "AZW3", "AZW", "MOBI", "PDF", "FB2", "DJVU",
  "CBZ", "CBR", "CB7", "TXT", "RTF", "DOCX", "ODT", "HTMLZ",
  "LIT", "PRC", "PDB", "LRF", "SNB", "TCR",
]);

async function main() {
  console.log("1. Validating plugins/zlib/plugin.json manifest...");
  const manifestPath = path.join(PLUGIN_DIR, "plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  assert.equal(manifest.api, 1, "api must be 1");
  assert.match(
    manifest.id,
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/,
    "id must match Dalibre pattern"
  );
  assert.ok(!manifest.id.startsWith("dalibre."), "id must not use reserved 'dalibre.' prefix");
  assert.ok(manifest.name && manifest.name.length <= 64, "name must be 1..64 chars");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "version must be semver");
  assert.ok(manifest.capabilities?.bookSource, "capabilities.bookSource must be present");
  assert.ok(Array.isArray(manifest.permissions?.hosts), "permissions.hosts must be an array");
  assert.equal(manifest.permissions?.localNetwork, true, "permissions.localNetwork must be true");

  for (const host of manifest.permissions.hosts) {
    assert.match(
      host,
      /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/,
      `Invalid host pattern: ${host}`
    );
  }
  console.log(`   ✓ Manifest valid: ${manifest.id} v${manifest.version} (${manifest.name})`);

  console.log("2. Initializing Dalibre QuickJS-equivalent prelude & loading main.js...");
  const settings = {};
  for (const s of manifest.settings || []) {
    if (s.default !== undefined) settings[s.key] = s.default;
  }
  if (process.env.ZLIB_BRIDGE_URL) {
    settings.bridgeUrl = process.env.ZLIB_BRIDGE_URL;
  }

  globalThis.dalibre = Object.freeze({
    api: 1,
    plugin: Object.freeze({ id: manifest.id, version: manifest.version }),
    settings: Object.freeze(settings),
    error(kind, message) {
      const e = new Error(message === undefined ? String(kind) : String(message));
      e.name = "DalibreError";
      e.kind = String(kind);
      return e;
    },
  });

  const mainModulePath = path.join(PLUGIN_DIR, manifest.main || "main.js");
  const mod = await import(pathToFileURL(mainModulePath).href);

  assert.equal(typeof mod.search, "function", "Book source must export search()");
  assert.equal(typeof mod.collections, "function", "Book source with collections:true must export collections()");
  assert.equal(typeof mod.list, "function", "Book source with collections:true must export list()");
  assert.equal(typeof mod.get, "function", "Book source should export get()");
  assert.equal(typeof mod.resolve, "function", "Book source should export resolve()");

  const cols = await mod.collections();
  assert.ok(Array.isArray(cols) && cols.length > 0 && cols.length <= 12, "collections() must return 1..12 items");
  console.log("   ✓ Exported collections:", cols.map((c) => `${c.id} (${c.title})`).join(", "));

  if (process.argv.includes("--live")) {
    const queryText = process.argv[process.argv.indexOf("--live") + 1] || "golang";
    console.log(`3. Running live end-to-end test via bridge (${settings.bridgeUrl}) with query "${queryText}"...`);

    const page = await mod.search({
      text: queryText,
      page: 1,
      cursor: "",
      filters: { format: "", language: "", sort: "popular" },
    });

    assert.ok(page && Array.isArray(page.items), "search() must return { items }");
    assert.ok(page.items.length > 0, "Expected at least 1 search result");
    console.log(`   ✓ search("${queryText}") returned ${page.items.length} results (hasMore: ${page.hasMore})`);

    for (const [idx, item] of page.items.entries()) {
      assert.ok(typeof item.id === "string" && item.id.length > 0 && item.id.length <= 256, `item[${idx}].id invalid`);
      assert.ok(typeof item.title === "string" && item.title.length > 0, `item[${idx}].title invalid`);
      assert.ok(Array.isArray(item.formats) && item.formats.length > 0, `item[${idx}].formats empty`);
      for (const f of item.formats) {
        assert.ok(VALID_FORMATS.has(f.format), `item[${idx}] invalid format ${f.format}`);
        if (f.size !== undefined) {
          assert.equal(typeof f.size, "number", `item[${idx}] format.size must be number of bytes`);
          assert.ok(Number.isInteger(f.size) && f.size > 0, `item[${idx}] format.size must be positive integer`);
        }
      }
      if (item.cover) {
        const u = new URL(item.cover);
        assert.ok(
          manifest.permissions.hosts.includes(u.hostname),
          `item[${idx}].cover host ${u.hostname} not in permissions.hosts`
        );
      }
    }

    const first = page.items[0];
    console.log(`   ✓ First result: [${first.id}] "${first.title}" by ${(first.authors || []).join(", ")} (${first.formats[0].format}, ${first.formats[0].size} bytes)`);

    console.log("4. Testing detail lookup get(firstItem) via MCP get_book...");
    const detailed = await mod.get(first);
    assert.equal(detailed.id, first.id);
    console.log(`   ✓ get(firstItem) succeeded: publisher="${detailed.publisher || ""}", identifiers=${JSON.stringify(detailed.identifiers)}`);

    console.log("5. Testing resolve(item, format) + file download stream...");
    // Pick the smallest book in search results for fast download verification
    const smallItem = [...page.items].sort(
      (a, b) => (a.formats[0]?.size || 999999999) - (b.formats[0]?.size || 999999999)
    )[0] || first;
    const dlReq = await mod.resolve(smallItem, smallItem.formats[0].format);
    assert.ok(dlReq && typeof dlReq.url === "string", "resolve() must return { url }");
    const dlUrl = new URL(dlReq.url);
    assert.ok(
      manifest.permissions.hosts.includes(dlUrl.hostname),
      `resolve().url host ${dlUrl.hostname} must be in permissions.hosts`
    );
    console.log(`   ✓ resolve() returned: ${dlReq.url} (filename: "${dlReq.filename || ""}")`);

    const fileRes = await fetch(dlReq.url);
    assert.equal(fileRes.status, 200, "Resolved file URL should return HTTP 200");
    const fileBuf = await fileRes.arrayBuffer();
    assert.ok(fileBuf.byteLength > 1000, "Downloaded ebook file should be > 1000 bytes");
    console.log(`   ✓ Downloaded "${dlReq.filename || smallItem.title}": ${fileBuf.byteLength} bytes`);

    if (first.cover) {
      console.log("6. Testing cover proxy endpoint...");
      const coverRes = await fetch(first.cover);
      assert.equal(coverRes.status, 200, "Cover proxy should return HTTP 200");
      const buf = await coverRes.arrayBuffer();
      assert.ok(buf.byteLength > 100, "Cover image should be non-empty");
      console.log(`   ✓ Cover proxy returned ${buf.byteLength} bytes (${coverRes.headers.get("content-type")})`);
    }
  }

  console.log("\nAll checks passed!");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
