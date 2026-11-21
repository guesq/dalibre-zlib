// @ts-check
// Z-Library book source for Dalibre. Every request goes through the zlib
// CLI (github.com/heartleo/zlib), which Dalibre gets and runs for us as
// this plugin's tool: it knows Z-Library's sign-in, mirrors and quotas.

import { mkdir, readFile, writeFile } from "node:fs/promises";

/** @type {Set<string>} */
const VALID_FORMATS = new Set([
  "EPUB", "KEPUB", "AZW3", "AZW", "MOBI", "PDF", "FB2", "DJVU",
  "CBZ", "CBR", "CB7", "TXT", "RTF", "DOCX", "ODT", "HTMLZ",
  "LIT", "PRC", "PDB", "LRF", "SNB", "TCR",
]);

/** @type {Record<string, string>} */
const LANG_TO_ISO = {
  english: "en", chinese: "zh", japanese: "ja", french: "fr", german: "de",
  spanish: "es", russian: "ru", italian: "it", portuguese: "pt", korean: "ko",
  dutch: "nl", polish: "pl", arabic: "ar", latin: "la", greek: "el",
  swedish: "sv", danish: "da", norwegian: "no", finnish: "fi", hungarian: "hu",
  catalan: "ca", esperanto: "eo",
};

/** @type {Record<string, string>} zlib's --language takes names */
const ISO_TO_LANG = Object.fromEntries(Object.entries(LANG_TO_ISO).map(([name, iso]) => [iso, name]));

const COLLECTIONS = [
  { id: "popular", title: "Most popular", command: "most-popular" },
  { id: "recommended", title: "Recommended", command: "recommended" },
  { id: "favorites", title: "Favorites", command: "favorites" },
];

// zlib's exit codes (docs/usage.md#exit-codes).
const EXIT_AUTH = 3;
const EXIT_NETWORK = 4;

const DOMAIN_STATE_PATH = "/data/domain.json";

/** @type {{ configuredDomain: string, activeDomain: string } | null} */
let cachedDomainState = null;

/** @type {Promise<string[]> | null} */
let doctorPromise = null;

/**
 * Normalizes a domain or URL to an origin ("https://host"), or "" when empty.
 * @param {string | undefined} raw
 * @returns {string}
 */
function normalizeOrigin(raw) {
  const val = String(raw || "").trim().replace(/\/+$/, "");
  if (!val) return "";
  try {
    const u = new URL(val.includes("://") ? val : `https://${val}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : val;
  } catch {
    return val;
  }
}

/**
 * Returns the domain currently in use: the auto-discovered healthy domain from
 * /data/domain.json (unless the user changed the Domain setting since then),
 * or the Domain setting itself.
 * @returns {Promise<string>}
 */
async function getActiveDomain() {
  const configured = normalizeOrigin(dalibre.settings.domain);
  if (!cachedDomainState) {
    try {
      const raw = await readFile(DOMAIN_STATE_PATH, "utf8");
      const parsed = JSON.parse(raw);
      cachedDomainState = {
        configuredDomain: normalizeOrigin(parsed?.configuredDomain),
        activeDomain: normalizeOrigin(parsed?.activeDomain),
      };
    } catch {
      cachedDomainState = { configuredDomain: configured, activeDomain: "" };
    }
  }
  if (cachedDomainState.configuredDomain !== configured) {
    cachedDomainState = { configuredDomain: configured, activeDomain: "" };
    try {
      await writeFile(DOMAIN_STATE_PATH, JSON.stringify(cachedDomainState));
    } catch {
      // ignore persistence errors
    }
  }
  return cachedDomainState.activeDomain || configured;
}

/**
 * Persists a newly discovered healthy domain to memory and /data/domain.json.
 * @param {string} domain
 */
async function saveActiveDomain(domain) {
  const configured = normalizeOrigin(dalibre.settings.domain);
  const active = normalizeOrigin(domain);
  cachedDomainState = { configuredDomain: configured, activeDomain: active };
  try {
    await writeFile(DOMAIN_STATE_PATH, JSON.stringify(cachedDomainState));
  } catch {
    // ignore persistence errors
  }
}

/**
 * The environment zlib runs with: the active or configured mirror.
 * @param {string} [domainOverride]
 * @returns {Promise<Record<string, string>>}
 */
async function env(domainOverride) {
  const domain = domainOverride !== undefined ? domainOverride : await getActiveDomain();
  return domain ? { ZLIB_DOMAIN: domain } : {};
}

/** @param {Dalibre.ExecResult} r */
function isDomainFailure(r) {
  if (r.code === EXIT_NETWORK) return true;
  const out = `${r.stderr || ""}\n${r.stdout || ""}`;
  return /run `zlib doctor`|is not usable for EAPI|domain is not configured/i.test(out);
}

/**
 * Extracts hostnames that just failed so failover picks a different mirror.
 * @param {string} domainUsed
 * @param {string} [output]
 * @returns {Set<string>}
 */
function extractFailedHosts(domainUsed, output = "") {
  /** @type {Set<string>} */
  const hosts = new Set();
  if (domainUsed) {
    try {
      hosts.add(new URL(domainUsed).hostname.toLowerCase());
    } catch {
      hosts.add(domainUsed.toLowerCase());
    }
  }
  for (const m of output.matchAll(/\(([a-z0-9-]+(?:\.[a-z0-9-]+)+)\)/gi)) {
    hosts.add(m[1].toLowerCase());
  }
  return hosts;
}

/**
 * Runs `zlib doctor --json` to find a healthy mirror, saves it as the new
 * active domain in /data/domain.json, and returns it.
 * @param {Set<string>} failedHosts
 * @param {string} previousDomain
 * @returns {Promise<string | null>}
 */
async function switchToHealthyDomain(failedHosts, previousDomain) {
  const current = await getActiveDomain();
  if (current && current !== previousDomain) {
    try {
      if (!failedHosts.has(new URL(current).hostname.toLowerCase())) return current;
    } catch {
      // continue to probe
    }
  }

  if (!doctorPromise) {
    doctorPromise = (async () => {
      try {
        const r = await dalibre.exec("zlib", ["doctor", "--json"], { timeout: 20000 });
        const list = JSON.parse(r.stdout || "[]");
        if (!Array.isArray(list)) return [];
        /** @type {string[]} */
        const origins = [];
        for (const item of list) {
          if (item?.status && item.status !== "healthy") continue;
          const candidate = normalizeOrigin(item?.final_url || item?.domain);
          if (candidate.startsWith("https://") && !origins.includes(candidate)) {
            origins.push(candidate);
          }
        }
        return origins;
      } catch {
        return [];
      } finally {
        doctorPromise = null;
      }
    })();
  }

  const origins = await doctorPromise;
  if (origins.length === 0) return null;

  const chosen =
    origins.find((origin) => {
      try {
        return !failedHosts.has(new URL(origin).hostname.toLowerCase());
      } catch {
        return true;
      }
    }) || origins[0];

  await saveActiveDomain(chosen);
  return chosen;
}

/**
 * Runs zlib with automatic domain failover on network or timeout errors.
 * @param {string[]} args
 * @param {Dalibre.ExecOptions} [options]
 * @returns {Promise<Dalibre.ExecResult>}
 */
async function execZlib(args, options = {}) {
  const totalTimeout = options.timeout ?? 60000;
  const initialTimeout = totalTimeout <= 60000 ? Math.min(totalTimeout, 15000) : totalTimeout;
  const domainUsed = await getActiveDomain();

  /** @type {Dalibre.ExecResult | null} */
  let firstResult = null;
  /** @type {unknown} */
  let firstError = null;

  try {
    firstResult = await dalibre.exec("zlib", args, {
      ...options,
      env: { ...(await env(domainUsed)), ...options.env },
      timeout: initialTimeout,
    });
  } catch (err) {
    firstError = err;
  }

  if (firstResult && !isDomainFailure(firstResult)) {
    return firstResult;
  }

  const output = firstResult ? `${firstResult.stderr || ""}\n${firstResult.stdout || ""}` : "";
  const failedHosts = extractFailedHosts(domainUsed, output);
  const newDomain = await switchToHealthyDomain(failedHosts, domainUsed);

  if (!newDomain) {
    if (firstError) throw firstError;
    return /** @type {Dalibre.ExecResult} */ (firstResult);
  }

  return dalibre.exec("zlib", args, {
    ...options,
    env: { ...(await env(newDomain)), ...options.env },
    timeout: totalTimeout,
  });
}

/**
 * Runs zlib with args and returns its output parsed as JSON, turning its
 * exit codes into errors Dalibre shows.
 * @param {string[]} args
 * @param {number} [timeout]
 */
async function zlib(args, timeout = 60000) {
  const r = await execZlib(args, { timeout });
  if (r.code !== 0) throw failure(r);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw dalibre.error("invalid", "zlib printed what isn’t JSON: " + r.stdout.slice(0, 200));
  }
}

/** @param {Dalibre.ExecResult} r */
function failure(r) {
  const msg = (r.stderr || r.stdout).trim().split("\n").pop() || `zlib exited with ${r.code}`;
  switch (r.code) {
    case EXIT_AUTH:
      return dalibre.error("auth", "Sign in to Z-Library: fill in your email and password in the plugin’s settings");
    case EXIT_NETWORK:
      return dalibre.error("unavailable", msg + " (try another domain in the plugin’s settings)");
  }
  return dalibre.error("unavailable", msg);
}

/**
 * Called when the plugin loads: signs in with the settings' account when
 * zlib isn't signed in yet.
 */
export async function check() {
  const profile = await execZlib(["profile", "--json"]);
  if (profile.code === 0) return;
  if (profile.code !== EXIT_AUTH) throw failure(profile);
  const email = (dalibre.settings.email || "").trim();
  const password = dalibre.settings.password || "";
  if (!email || !password) {
    throw dalibre.error("auth", "Sign in to Z-Library: fill in your email and password in the plugin’s settings");
  }
  const login = await execZlib(["login", "--email", email, "--password", password]);
  if (login.code !== 0) {
    throw dalibre.error("auth", "Z-Library refused the sign-in: " + (login.stderr || login.stdout).trim().split("\n").pop());
  }
}

/** @returns {Dalibre.Collection[]} */
export function collections() {
  return COLLECTIONS.map(({ id, title }) => ({ id, title }));
}

/**
 * @param {Dalibre.Query} query
 * @returns {Promise<Dalibre.Page>}
 */
export async function list({ collection, page, filters }) {
  const col = COLLECTIONS.find((c) => c.id === (collection || "popular"));
  if (!col) throw dalibre.error("notFound", `Unknown collection: ${collection}`);
  const p = page || 1;
  // Only favorites has pages; the others are one list.
  if (col.id !== "favorites" && p > 1) return { items: [] };
  const args = [col.command, "--json"];
  if (col.id === "favorites") args.push("--page", String(p));
  const data = await zlib(args);
  let books = Array.isArray(data) ? data : data.books || [];
  const ext = filters?.format || "";
  const lang = filters?.language || "";
  if (ext) books = books.filter((/** @type {any} */ b) => String(b.extension || "").toLowerCase() === ext);
  if (lang) books = books.filter((/** @type {any} */ b) => normalizeLanguage(b.language) === lang);
  return toPage(books, p, Number(data.total_pages) || 1);
}

/**
 * @param {Dalibre.Query} query
 * @returns {Promise<Dalibre.Page>}
 */
export async function search({ text, page, filters }) {
  const q = (text || "").trim();
  if (!q) return list({ text: "", page: page || 1, cursor: "", filters: filters || {}, collection: "popular" });
  const p = page || 1;
  const args = ["search", q, "--json", "--page", String(p), "--count", "25"];
  if (filters?.format) args.push("--ext", filters.format);
  if (filters?.language) args.push("--language", ISO_TO_LANG[filters.language] || filters.language);
  if (filters?.sort) args.push("--order", filters.sort);
  const data = await zlib(args);
  return toPage(data.books || [], p, Number(data.total_pages) || 1);
}

/**
 * A book's details for the detail panel: tries zlib's MCP get_book first,
 * and falls back to zlib search by ISBN/title when MCP stdio closes early.
 * @param {Dalibre.Result} item
 * @returns {Promise<Dalibre.Result>}
 */
export async function get(item) {
  const mcpBook = await fetchBookViaMCP(item.id);
  if (mcpBook) return mergeBookDetails(item, mcpBook);
  if (item.formats?.some((f) => f.size) && item.description) return item;
  const searchBook = await findBookBySearch(item);
  return searchBook ? mergeBookDetails(item, searchBook) : item;
}

/**
 * Queries zlib's read-only MCP server for get_book; returns null if stdout
 * closes before answering (e.g. when the host closes stdin immediately).
 * @param {string} id
 * @returns {Promise<any | null>}
 */
async function fetchBookViaMCP(id) {
  const call = (/** @type {number} */ reqId, /** @type {string} */ method, /** @type {any} */ params) =>
    JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params });
  const stdin = [
    call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dalibre", version: "1" } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    call(2, "tools/call", { name: "get_book", arguments: { id } }),
  ].join("\n") + "\n";
  let r;
  try {
    r = await execZlib(["mcp", "--read-only"], { stdin, timeout: 30000 });
  } catch {
    return null;
  }
  for (const line of r.stdout.split("\n")) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== 2 || !msg.result || msg.result.isError) continue;
    if (msg.result.structuredContent) return msg.result.structuredContent;
    try {
      return JSON.parse(msg.result.content?.[0]?.text || "");
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Fallback lookup via `zlib search --json` matching item.id exactly.
 * @param {Dalibre.Result} item
 * @returns {Promise<any | null>}
 */
async function findBookBySearch(item) {
  const isbn = String(item.identifiers?.isbn || "").split(/[\s,;]+/)[0].trim();
  const title = String(item.title || "").trim();
  /** @type {{ q: string, count: string }[]} */
  const attempts = [];
  if (isbn) attempts.push({ q: isbn, count: "25" });
  if (title && title !== isbn) attempts.push({ q: title, count: "50" });

  for (const { q, count } of attempts) {
    try {
      const data = await zlib(["search", q, "--json", "--page", "1", "--count", count], 20000);
      const hit = (data.books || []).find((/** @type {any} */ b) => String(b?.id || "") === item.id);
      if (hit) return hit;
    } catch {
      // the list's details will do
    }
  }
  return null;
}

/**
 * Merges enriched metadata onto an existing list item without dropping existing fields.
 * @param {Dalibre.Result} item
 * @param {any} rawBook
 * @returns {Dalibre.Result}
 */
function mergeBookDetails(item, rawBook) {
  const more = toResult({ ...rawBook, id: item.id, url: item.url, cover: item.cover }, true);
  if (!more) return item;
  const defined = /** @type {Partial<Dalibre.Result>} */ (
    Object.fromEntries(Object.entries(more).filter(([, v]) => v !== undefined))
  );
  return {
    ...item,
    ...defined,
    identifiers: { ...item.identifiers, ...more.identifiers },
    cover: item.cover,
    url: item.url,
    formats: more.formats.length > 0 ? more.formats : item.formats,
  };
}

/**
 * zlib downloads the book into /work; Dalibre moves it into the library.
 * @param {Dalibre.Result} item
 * @returns {Promise<Dalibre.DownloadRequest>}
 */
export async function resolve(item) {
  const dir = `/work/dl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await mkdir(dir, { recursive: true });
  const info = await zlib(["download", item.id, "--dir", dir, "--json"], 10 * 60000);
  const name = String(info.path || "").split(/[\\/]/).pop();
  if (!name) throw dalibre.error("notFound", "zlib didn’t say where it saved the book");
  return { path: `${dir}/${name}` };
}

/**
 * @param {any[]} books
 * @param {number} page
 * @param {number} totalPages
 * @returns {Dalibre.Page}
 */
function toPage(books, page, totalPages) {
  /** @type {Dalibre.Result[]} */
  const items = [];
  for (const b of books) {
    const r = toResult(b);
    if (r) items.push(r);
  }
  return { items: items.slice(0, 100), hasMore: page < totalPages && items.length > 0 };
}

/**
 * @param {any} b a book as zlib's --json prints it
 * @param {boolean} [details] b is get_book's details, without a format
 * @returns {Dalibre.Result | null}
 */
function toResult(b, details = false) {
  if (!b || !b.id || !b.name) return null;
  // most-popular and recommended omit extension; fall back to EPUB unless explicit extension is unsupported
  const fmt = normalizeFormat(b.extension) || (!b.extension && !details ? "EPUB" : null);
  if (!fmt && !details) return null;

  /** @type {Record<string, string>} */
  const identifiers = { zlib: String(b.id) };
  const isbn = String(b.isbn_13 || b.isbn || b.isbn_10 || "").trim();
  if (isbn) identifiers.isbn = isbn;

  /** @type {Dalibre.Field[]} */
  const fields = [];
  if (b.size) fields.push({ label: "Size", value: String(b.size) });
  if (b.pages && b.pages !== "0") fields.push({ label: "Pages", value: String(b.pages) });
  if (b.edition) fields.push({ label: "Edition", value: String(b.edition) });
  if (b.rating && b.rating !== "0.0" && b.rating !== "0") {
    fields.push({ label: "Rating", value: b.quality && b.quality !== "0.0" ? `${b.rating} (Quality ${b.quality})` : String(b.rating) });
  }
  if (isbn) fields.push({ label: "ISBN", value: isbn });

  const year = String(b.year || "").trim();
  const tags = b.categories
    ? String(b.categories).split(/[,;/|]/).map((s) => s.trim()).filter(Boolean).slice(0, 8)
    : [];
  const sizeBytes = parseSizeBytes(b.size);

  return {
    id: String(b.id).slice(0, 256),
    title: String(b.name).trim(),
    authors: Array.isArray(b.authors) && b.authors.length > 0 ? b.authors.map(String) : undefined,
    description: b.description ? String(b.description).trim() : undefined,
    publisher: b.publisher ? String(b.publisher).trim() : undefined,
    language: normalizeLanguage(b.language),
    pubdate: /^[12]\d{3}$/.test(year) ? year : undefined,
    tags: tags.length > 0 ? tags : undefined,
    identifiers,
    cover: coverURL(b),
    url: b.url && /^https?:\/\//i.test(b.url) ? String(b.url) : undefined,
    fields: fields.length > 0 ? fields.slice(0, 12) : undefined,
    formats: fmt ? [{ format: fmt, ...(sizeBytes ? { size: sizeBytes } : {}) }] : [],
  };
}

/**
 * A book's cover as an absolute https URL: zlib gives some relative to the
 * book's page. Covers are on mirrors and CDNs, which permissions.covers
 * "any" lets Dalibre load.
 * @param {any} b
 */
function coverURL(b) {
  if (!b.cover) return undefined;
  try {
    const u = new URL(String(b.cover), b.url || undefined);
    return u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {string | undefined} ext
 * @returns {Dalibre.FormatName | null}
 */
function normalizeFormat(ext) {
  if (!ext) return null;
  const upper = String(ext).trim().replace(/^\./, "").toUpperCase();
  if (upper === "DOC") return "DOCX";
  if (upper === "HTM" || upper === "HTML") return "HTMLZ";
  return VALID_FORMATS.has(upper) ? /** @type {Dalibre.FormatName} */ (upper) : null;
}

/**
 * @param {string | undefined} lang
 * @returns {string | undefined}
 */
function normalizeLanguage(lang) {
  if (!lang) return undefined;
  const raw = String(lang).trim();
  const lower = raw.toLowerCase();
  if (LANG_TO_ISO[lower]) return LANG_TO_ISO[lower];
  if (/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(raw)) return raw;
  return undefined;
}

/**
 * "2.51 MB" or "450 KB" in bytes.
 * @param {string | number | undefined} size
 * @returns {number | undefined}
 */
function parseSizeBytes(size) {
  if (typeof size === "number" && Number.isFinite(size) && size > 0) return Math.round(size);
  if (typeof size !== "string") return undefined;
  const m = /^([\d.]+)\s*(B|KB|MB|GB)$/i.exec(size.trim());
  if (!m) return undefined;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[/** @type {"B"|"KB"|"MB"|"GB"} */ (m[2].toUpperCase())];
  return Math.round(num * mult);
}
