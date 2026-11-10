// @ts-check
// Z-Library book source for Dalibre, backed by the local zlib CLI bridge.

const DEFAULT_BRIDGE = "http://localhost:17890";

/** @type {Set<string>} */
const VALID_FORMATS = new Set([
  "EPUB", "KEPUB", "AZW3", "AZW", "MOBI", "PDF", "FB2", "DJVU",
  "CBZ", "CBR", "CB7", "TXT", "RTF", "DOCX", "ODT", "HTMLZ",
  "LIT", "PRC", "PDB", "LRF", "SNB", "TCR",
]);

/** @type {Record<string, string>} */
const LANG_TO_ISO = {
  english: "en",
  chinese: "zh",
  japanese: "ja",
  french: "fr",
  german: "de",
  spanish: "es",
  russian: "ru",
  italian: "it",
  portuguese: "pt",
  korean: "ko",
  dutch: "nl",
  polish: "pl",
  arabic: "ar",
  latin: "la",
  greek: "el",
  swedish: "sv",
  danish: "da",
  norwegian: "no",
  finnish: "fi",
  hungarian: "hu",
  catalan: "ca",
  esperanto: "eo",
};

const COLLECTIONS = [
  { id: "popular", title: "Most popular" },
  { id: "recommended", title: "Recommended" },
  { id: "favorites", title: "Favorites" },
];

function bridgeBase() {
  const raw = (dalibre.settings?.bridgeUrl || DEFAULT_BRIDGE).trim();
  const base = (raw || DEFAULT_BRIDGE).replace(/\/+$/, "");
  // Prefer localhost over 127.0.0.1 so macOS system proxy ExceptionsList bypasses local proxy
  return base.replace(/^http:\/\/127\.0\.0\.1(?=:|\/|$)/i, "http://localhost");
}

function extraSettingsQuery() {
  const domain = (dalibre.settings?.domain || "").trim();
  const proxy = (dalibre.settings?.proxy || "system").trim();
  return (
    (proxy ? `&proxy=${encodeURIComponent(proxy)}` : "") +
    (domain ? `&domain=${encodeURIComponent(domain)}` : "")
  );
}

/**
 * @returns {Dalibre.Collection[]}
 */
export function collections() {
  return COLLECTIONS.map(({ id, title }) => ({ id, title }));
}

/**
 * @param {Dalibre.Query} query
 * @returns {Promise<Dalibre.Page>}
 */
export async function list({ collection, page, filters }) {
  const base = bridgeBase();
  const col = collection || "popular";
  if (!COLLECTIONS.some((c) => c.id === col)) {
    throw dalibre.error("notFound", `Unknown collection: ${col}`);
  }
  const p = page || 1;
  const ext = filters?.format || "";
  const lang = filters?.language || "";
  const url =
    `${base}/collection?id=${encodeURIComponent(col)}&page=${p}` +
    (ext ? `&ext=${encodeURIComponent(ext)}` : "") +
    (lang ? `&lang=${encodeURIComponent(lang)}` : "") +
    extraSettingsQuery();

  const data = await fetchBridgeJSON(url);
  return toPage(data, base, p);
}

/**
 * @param {Dalibre.Query} query
 * @returns {Promise<Dalibre.Page>}
 */
export async function search({ text, page, filters }) {
  const q = (text || "").trim();
  if (!q) {
    return list({ text: "", page: page || 1, cursor: "", filters: filters || {}, collection: "popular" });
  }
  const base = bridgeBase();
  const p = page || 1;
  const ext = filters?.format || "";
  const lang = filters?.language || "";
  const sort = filters?.sort || "popular";
  const url =
    `${base}/search?q=${encodeURIComponent(q)}&page=${p}&count=25` +
    (ext ? `&ext=${encodeURIComponent(ext)}` : "") +
    (lang ? `&lang=${encodeURIComponent(lang)}` : "") +
    (sort ? `&order=${encodeURIComponent(sort)}` : "") +
    extraSettingsQuery();

  const data = await fetchBridgeJSON(url);
  return toPage(data, base, p);
}

/**
 * Enriches a result with full book metadata when opened in the detail panel.
 * @param {Dalibre.Result} item
 * @returns {Promise<Dalibre.Result>}
 */
export async function get(item) {
  const base = bridgeBase();
  try {
    const b = await fetchBridgeJSON(
      `${base}/book?id=${encodeURIComponent(item.id)}${extraSettingsQuery()}`
    );
    if (!b || !b.id) return item;
    const enriched = toResult(b, base);
    if (!enriched) return item;
    return {
      ...item,
      ...enriched,
      cover: enriched.cover || item.cover,
      url: enriched.url || item.url,
      formats: enriched.formats.length > 0 ? enriched.formats : item.formats,
    };
  } catch {
    return item;
  }
}

/**
 * Two-phase download resolution: asks the local bridge to download the book via
 * zlib CLI (using configured domain & system/custom proxy) into a temporary file,
 * then hands Dalibre a fast local streaming URL.
 * @param {Dalibre.Result} item
 * @param {Dalibre.FormatName} format
 * @returns {Promise<Dalibre.DownloadRequest>}
 */
export async function resolve(item, format) {
  const base = bridgeBase();
  const prepUrl =
    `${base}/prepare?id=${encodeURIComponent(item.id)}&format=${encodeURIComponent(format)}` +
    extraSettingsQuery();
  const data = await fetchBridgeJSON(prepUrl);
  if (!data || !data.token) {
    throw dalibre.error("unavailable", "Failed to prepare book download from Z-Library");
  }
  return {
    url: `${base}/file?token=${encodeURIComponent(data.token)}`,
    ...(data.filename ? { filename: String(data.filename) } : {}),
  };
}

/**
 * @param {string} url
 * @returns {Promise<any>}
 */
async function fetchBridgeJSON(url) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    throw dalibre.error(
      "unavailable",
      `Cannot connect to local zlib-bridge (${bridgeBase()}). Make sure the bridge service is running.`
    );
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON response
  }

  if (!res.ok) {
    const msg = data?.error || `zlib-bridge returned HTTP ${res.status}`;
    if (res.status === 401 || data?.kind === "auth") {
      throw dalibre.error("auth", `${msg} (Run 'zlib login' in terminal)`);
    }
    if (res.status === 429 || data?.kind === "rateLimited") {
      throw dalibre.error("rateLimited", msg);
    }
    if (res.status === 404 || data?.kind === "notFound") {
      throw dalibre.error("notFound", msg);
    }
    throw dalibre.error("unavailable", msg);
  }
  return data;
}

/**
 * @param {any} data
 * @param {string} base
 * @param {number} currentPage
 * @returns {Dalibre.Page}
 */
function toPage(data, base, currentPage) {
  const rawBooks = Array.isArray(data?.books) ? data.books : [];
  /** @type {Dalibre.Result[]} */
  const items = [];
  for (const b of rawBooks) {
    const r = toResult(b, base);
    if (r) items.push(r);
  }
  const totalPages = Number(data?.total_pages) || 1;
  return {
    items: items.slice(0, 100),
    hasMore: currentPage < totalPages && items.length > 0,
  };
}

/**
 * @param {any} b
 * @param {string} base
 * @returns {Dalibre.Result | null}
 */
function toResult(b, base) {
  if (!b || !b.id || !b.name) return null;

  const fmt = normalizeFormat(b.extension);
  if (!fmt) return null;

  const sizeBytes = parseSizeBytes(b.size);
  const extra = extraSettingsQuery();
  const downloadUrl = `${base}/download?id=${encodeURIComponent(String(b.id))}${extra}`;

  /** @type {Dalibre.Format} */
  const formatObj = {
    format: fmt,
    url: downloadUrl,
    ...(sizeBytes ? { size: sizeBytes } : {}),
  };

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
    const ratingStr =
      b.quality && b.quality !== "0.0" ? `${b.rating} (Quality ${b.quality})` : String(b.rating);
    fields.push({ label: "Rating", value: ratingStr });
  }
  if (isbn) fields.push({ label: "ISBN", value: isbn });

  const langIso = normalizeLanguage(b.language);
  const year = String(b.year || "").trim();
  const validYear = /^[12]\d{3}$/.test(year) ? year : undefined;

  const tags = b.categories
    ? String(b.categories)
        .split(/[,;/|]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8)
    : undefined;

  let cover = "";
  const rawCover = b.cover_raw || b.cover || "";
  if (typeof rawCover === "string" && rawCover.startsWith(base)) {
    cover = rawCover;
  } else if (typeof rawCover === "string" && /^https?:\/\//i.test(rawCover)) {
    cover = `${base}/cover?url=${encodeURIComponent(rawCover)}${extra}`;
  }

  return {
    id: String(b.id).slice(0, 256),
    title: String(b.name).trim(),
    authors: Array.isArray(b.authors) && b.authors.length > 0 ? b.authors.map(String) : undefined,
    description: b.description ? String(b.description).trim() : undefined,
    publisher: b.publisher ? String(b.publisher).trim() : undefined,
    language: langIso,
    pubdate: validYear,
    tags: tags && tags.length > 0 ? tags : undefined,
    identifiers,
    cover: cover || undefined,
    url: b.url && /^https?:\/\//i.test(b.url) ? String(b.url) : undefined,
    fields: fields.length > 0 ? fields.slice(0, 12) : undefined,
    formats: [formatObj],
  };
}

/**
 * @param {string | undefined} ext
 * @returns {Dalibre.FormatName | null}
 */
function normalizeFormat(ext) {
  if (!ext) return "EPUB";
  const upper = String(ext).trim().replace(/^\./, "").toUpperCase();
  if (upper === "DOC") return "DOCX";
  if (upper === "HTM" || upper === "HTML") return "HTMLZ";
  if (VALID_FORMATS.has(upper)) {
    return /** @type {Dalibre.FormatName} */ (upper);
  }
  return null;
}

/**
 * @param {string | undefined} lang
 * @returns {string | undefined}
 */
function normalizeLanguage(lang) {
  if (!lang) return undefined;
  const raw = String(lang).trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (LANG_TO_ISO[lower]) return LANG_TO_ISO[lower];
  if (/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(raw)) return raw;
  return undefined;
}

/**
 * Converts human-readable size strings like "2.51 MB" or "450 KB" into integer bytes.
 * @param {string | number | undefined} sizeVal
 * @returns {number | undefined}
 */
function parseSizeBytes(sizeVal) {
  if (typeof sizeVal === "number" && Number.isFinite(sizeVal) && sizeVal > 0) {
    return Math.round(sizeVal);
  }
  if (typeof sizeVal !== "string") return undefined;
  const m = /^([\d.]+)\s*(B|KB|MB|GB)$/i.exec(sizeVal.trim());
  if (!m) return undefined;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  const unit = m[2].toUpperCase();
  const mult =
    unit === "GB"
      ? 1024 * 1024 * 1024
      : unit === "MB"
      ? 1024 * 1024
      : unit === "KB"
      ? 1024
      : 1;
  return Math.round(num * mult);
}
