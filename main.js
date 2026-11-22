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

// Thresholds and intervals for domain probing and selection.
const SLOW_REQUEST_THRESHOLD_MS = 8000;
const INITIAL_REQUEST_TIMEOUT_MS = 15000;
const STAGE1_PROBE_TIMEOUT_MS = 3500;
const STAGE1_EARLY_CUTOFF_MS = 2000;
const STAGE2_PROBE_TIMEOUT_MS = 3000;
const MAX_ACCEPTABLE_USER_RTT_MS = 3000;
const USER_DOMAIN_RTT_RATIO = 2.0;
const USER_DOMAIN_RTT_GRACE_MS = 250;
const SWITCH_IMPROVEMENT_RATIO = 0.75;
const SWITCH_IMPROVEMENT_MIN_MS = 150;
const BASE_SLOW_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_SLOW_COOLDOWN_MS = 60 * 60 * 1000;
const RECENT_PROBE_FAILOVER_WINDOW_MS = 60 * 1000;

/** Built-in Z-Library mirror origins from heartleo/zlib. */
const BUILTIN_DOMAINS = [
  "https://1lib.sk",
  "https://article.sk",
  "https://articles.sk",
  "https://z-lib.by",
  "https://z-lib.fm",
  "https://z-lib.gd",
  "https://z-lib.gl",
  "https://z-lib.sk",
  "https://z-library.ec",
  "https://z-library.im",
  "https://z-library.qa",
  "https://z-library.sk",
  "https://z-library.website",
  "https://zlib.bz",
];

/**
 * @typedef {Object} DomainState
 * @property {string} configuredDomain
 * @property {string} envDomain
 * @property {string} activeDomain
 * @property {string[]} backupDomains
 * @property {string[]} knownDomains
 * @property {number} lastProbeAt
 * @property {number} noBetterCount
 */

/**
 * @typedef {Object} DomainProbeStats
 * @property {string} origin
 * @property {number} successes
 * @property {number} attempts
 * @property {number} avgRtt
 * @property {number} maxRtt
 */

/** @type {DomainState | null} */
let cachedDomainState = null;

/** @type {Promise<string | null> | null} */
let activeEvaluationPromise = null;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalizes a domain or URL to an origin ("https://host"), or "" when empty.
 * @param {string | undefined | null} raw
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
 * @param {unknown} list
 * @returns {string[]}
 */
function normalizeOriginList(list) {
  if (!Array.isArray(list)) return [];
  /** @type {string[]} */
  const out = [];
  for (const item of list) {
    const origin = normalizeOrigin(typeof item === "string" ? item : "");
    if (origin.startsWith("https://") && !out.includes(origin)) {
      out.push(origin);
    }
  }
  return out;
}

/**
 * Extracts the lowercase hostname from an origin or URL string.
 * @param {string} raw
 * @returns {string}
 */
function extractHost(raw) {
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/**
 * Loads and synchronizes the persistent domain state from /data/domain.json.
 * Resets automatic selection if the user changed dalibre.settings.domain.
 * @returns {Promise<DomainState>}
 */
async function loadDomainState() {
  const configured = normalizeOrigin(dalibre.settings.domain);
  if (!cachedDomainState) {
    try {
      const raw = await readFile(DOMAIN_STATE_PATH, "utf8");
      const parsed = JSON.parse(raw);
      cachedDomainState = {
        configuredDomain: normalizeOrigin(parsed?.configuredDomain),
        envDomain: normalizeOrigin(parsed?.envDomain),
        activeDomain: normalizeOrigin(parsed?.activeDomain),
        backupDomains: normalizeOriginList(parsed?.backupDomains),
        knownDomains: normalizeOriginList(parsed?.knownDomains),
        lastProbeAt: Number(parsed?.lastProbeAt) || 0,
        noBetterCount: Number(parsed?.noBetterCount) || 0,
      };
    } catch {
      cachedDomainState = {
        configuredDomain: configured,
        envDomain: "",
        activeDomain: "",
        backupDomains: [],
        knownDomains: [],
        lastProbeAt: 0,
        noBetterCount: 0,
      };
    }
  }
  if (cachedDomainState.configuredDomain !== configured) {
    cachedDomainState = {
      ...cachedDomainState,
      configuredDomain: configured,
      activeDomain: "",
      backupDomains: [],
      lastProbeAt: 0,
      noBetterCount: 0,
    };
    await saveDomainState(cachedDomainState);
  }
  return cachedDomainState;
}

/**
 * Persists the domain state to memory and /data/domain.json.
 * @param {DomainState} state
 */
async function saveDomainState(state) {
  cachedDomainState = state;
  try {
    await writeFile(DOMAIN_STATE_PATH, JSON.stringify(state));
  } catch {
    // ignore persistence errors
  }
}

/**
 * Returns the domain currently in use.
 * @returns {Promise<string>}
 */
async function getActiveDomain() {
  const state = await loadDomainState();
  return state.activeDomain || state.configuredDomain || state.envDomain;
}

/**
 * The environment zlib runs with: the active or overridden mirror.
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
  const usedHost = extractHost(domainUsed);
  if (usedHost) hosts.add(usedHost);
  for (const m of output.matchAll(/\(([a-z0-9-]+(?:\.[a-z0-9-]+)+)\)/gi)) {
    hosts.add(m[1].toLowerCase());
  }
  return hosts;
}

/**
 * Collects the user's .env / session domain and custom trusted mirrors from
 * the local zlib configuration files (no network calls), and merges all known
 * candidate domains.
 * @param {DomainState} state
 * @returns {Promise<{ userPreferredDomain: string, candidates: string[] }>}
 */
async function collectCandidatesAndConfig(state) {
  const [cfgRes, mirrorsRes] = await Promise.all([
    dalibre.exec("zlib", ["config", "network", "domain", "--json"], { timeout: 3000 }).catch(() => null),
    dalibre.exec("zlib", ["mirrors", "list", "--json"], { timeout: 3000 }).catch(() => null),
  ]);

  let envDomain = state.envDomain;
  if (cfgRes && cfgRes.code === 0) {
    try {
      const parsed = JSON.parse(cfgRes.stdout || "[]");
      const entry = Array.isArray(parsed)
        ? parsed.find((/** @type {any} */ item) => item?.key === "ZLIB_DOMAIN")
        : null;
      if (entry) {
        const saved = normalizeOrigin(entry.saved);
        const val = entry.source && entry.source !== "Default" ? normalizeOrigin(entry.value) : "";
        envDomain = saved || val;
      }
    } catch {
      // keep previous envDomain
    }
  }

  if (envDomain !== state.envDomain) {
    state.envDomain = envDomain;
    state.noBetterCount = 0;
  }

  /** @type {string[]} */
  let userMirrors = [];
  if (mirrorsRes && mirrorsRes.code === 0) {
    try {
      userMirrors = normalizeOriginList(JSON.parse(mirrorsRes.stdout || "[]"));
    } catch {
      userMirrors = [];
    }
  }

  const configured = normalizeOrigin(dalibre.settings.domain);
  const userPreferredDomain = configured || envDomain;

  /** @type {string[]} */
  const candidates = [];
  /** @param {string} raw */
  const addCandidate = (raw) => {
    const origin = normalizeOrigin(raw);
    if (origin.startsWith("https://") && !candidates.includes(origin)) {
      candidates.push(origin);
    }
  };

  addCandidate(userPreferredDomain);
  addCandidate(state.activeDomain);
  for (const m of userMirrors) addCandidate(m);
  for (const b of state.backupDomains) addCandidate(b);
  for (const d of BUILTIN_DOMAINS) addCandidate(d);
  for (const k of state.knownDomains) addCandidate(k);

  return { userPreferredDomain, candidates };
}

/**
 * Probes a single domain once via `zlib profile --json` and measures end-to-end
 * EAPI latency.
 * @param {string} origin
 * @param {number} timeoutMs
 * @returns {Promise<{ origin: string, ok: boolean, rtt: number, notLoggedIn: boolean }>}
 */
async function probeDomainOnce(origin, timeoutMs) {
  const start = Date.now();
  try {
    const r = await dalibre.exec("zlib", ["profile", "--json"], {
      env: { ZLIB_DOMAIN: origin },
      timeout: timeoutMs,
    });
    const rtt = Math.max(1, Date.now() - start);
    if (r.code === 0) {
      try {
        const parsed = JSON.parse(r.stdout || "{}");
        if (parsed && typeof parsed === "object") {
          return { origin, ok: true, rtt, notLoggedIn: false };
        }
      } catch {
        // non-JSON response
      }
      return { origin, ok: false, rtt, notLoggedIn: false };
    }
    if (r.code === EXIT_AUTH) {
      const out = `${r.stderr || ""}\n${r.stdout || ""}`;
      if (/not logged in\. Run `zlib login` first/i.test(out)) {
        return { origin, ok: false, rtt, notLoggedIn: true };
      }
      if (/session expired or was revoked/i.test(out)) {
        // The mirror's EAPI answered properly with a JSON auth status.
        return { origin, ok: true, rtt, notLoggedIn: false };
      }
    }
    return { origin, ok: false, rtt, notLoggedIn: false };
  } catch {
    return { origin, ok: false, rtt: Math.max(1, Date.now() - start), notLoggedIn: false };
  }
}

/**
 * Fallback discovery via `zlib doctor --json` when no session exists yet or
 * when all known candidates fail Stage 1. Also records any newly discovered
 * built-in domains into state.knownDomains.
 * @param {DomainState} state
 * @param {Set<string>} failedHosts
 * @returns {Promise<string[]>}
 */
async function discoverHealthyViaDoctor(state, failedHosts) {
  try {
    const r = await dalibre.exec("zlib", ["doctor", "--json"], { timeout: 15000 });
    const list = JSON.parse(r.stdout || "[]");
    if (!Array.isArray(list)) return [];
    /** @type {string[]} */
    const healthy = [];
    for (const item of list) {
      const rawDomain = normalizeOrigin(item?.domain);
      const finalOrigin = normalizeOrigin(item?.final_url || item?.domain);
      for (const d of [rawDomain, finalOrigin]) {
        if (d.startsWith("https://") && !BUILTIN_DOMAINS.includes(d) && !state.knownDomains.includes(d)) {
          state.knownDomains.push(d);
        }
      }
      if (item?.status && item.status !== "healthy") continue;
      if (finalOrigin.startsWith("https://") && !failedHosts.has(extractHost(finalOrigin)) && !healthy.includes(finalOrigin)) {
        healthy.push(finalOrigin);
      }
    }
    return healthy;
  } catch {
    return [];
  }
}

/**
 * Pure decision function that picks the winning domain and backup list from
 * 3-round probe statistics according to user preference (2x threshold) and
 * active domain hysteresis (25% / 150ms threshold).
 * @param {Object} params
 * @param {DomainProbeStats[]} params.statsList
 * @param {string} params.userPreferredDomain
 * @param {string} params.currentActiveDomain
 * @returns {{ chosen: string | null, fastest: DomainProbeStats | null, backups: string[] }}
 */
function selectBestDomain({ statsList, userPreferredDomain, currentActiveDomain }) {
  const viable = statsList.filter((s) => s.successes > 0);
  if (viable.length === 0) {
    return { chosen: null, fastest: null, backups: [] };
  }

  const ranked = [...viable].sort((a, b) => {
    if (b.successes !== a.successes) return b.successes - a.successes;
    if (a.avgRtt !== b.avgRtt) return a.avgRtt - b.avgRtt;
    return a.maxRtt - b.maxRtt;
  });

  const fastest = ranked[0];
  const maxSuccesses = fastest.successes;

  /** @type {string | null} */
  let chosen = null;

  // Rule A: User-configured domain (.env or plugin setting) takes priority if
  // packet-loss-free and within 2x of the fastest domain's latency.
  if (userPreferredDomain) {
    const userStats = viable.find((s) => s.origin === userPreferredDomain);
    if (
      userStats &&
      userStats.successes === maxSuccesses &&
      userStats.avgRtt <= MAX_ACCEPTABLE_USER_RTT_MS &&
      userStats.avgRtt <= Math.max(USER_DOMAIN_RTT_RATIO * fastest.avgRtt, fastest.avgRtt + USER_DOMAIN_RTT_GRACE_MS)
    ) {
      chosen = userStats.origin;
    }
  }

  // Rule B: If automatic selection is used, keep the current activeDomain
  // unless it had packet loss or fastest is >25% (and >=150ms) faster.
  if (!chosen && currentActiveDomain) {
    const activeStats = viable.find((s) => s.origin === currentActiveDomain);
    if (activeStats && activeStats.successes === maxSuccesses && activeStats.avgRtt <= MAX_ACCEPTABLE_USER_RTT_MS) {
      const clearlyFaster =
        fastest.origin !== activeStats.origin &&
        fastest.avgRtt <= SWITCH_IMPROVEMENT_RATIO * activeStats.avgRtt &&
        activeStats.avgRtt - fastest.avgRtt >= SWITCH_IMPROVEMENT_MIN_MS;
      if (!clearlyFaster) {
        chosen = activeStats.origin;
      }
    }
  }

  if (!chosen) {
    chosen = fastest.origin;
  }

  const backups = ranked
    .filter((s) => s.origin !== chosen && s.successes === maxSuccesses)
    .slice(0, 3)
    .map((s) => s.origin);

  return { chosen, fastest, backups };
}

/**
 * Runs the two-stage 3-round probing and domain selection algorithm.
 * @param {Object} [options]
 * @param {Set<string>} [options.failedHosts]
 * @param {"startup" | "slow" | "failure"} [options.reason]
 * @returns {Promise<string | null>}
 */
async function evaluateAndSelectDomain(options = {}) {
  const failedHosts = options.failedHosts || new Set();
  const reason = options.reason || "startup";

  if (activeEvaluationPromise) {
    const shared = await activeEvaluationPromise;
    if (shared && !failedHosts.has(extractHost(shared))) return shared;
  }

  const runPromise = (async () => {
    const state = await loadDomainState();
    const previousActive = state.activeDomain || state.configuredDomain || state.envDomain;
    const { userPreferredDomain, candidates } = await collectCandidatesAndConfig(state);
    const pool = candidates.filter((origin) => !failedHosts.has(extractHost(origin)));

    if (pool.length === 0) return null;

    // Stage 1: Concurrent initial screening (1 round) with early cutoff.
    /** @type {Map<string, { origin: string, ok: boolean, rtt: number, notLoggedIn: boolean }>} */
    const stage1Map = new Map();
    let sawNotLoggedIn = false;

    const mustWaitOrigins = [userPreferredDomain, state.activeDomain].filter(
      (d) => d && pool.includes(d)
    );

    await new Promise((resolveStage1) => {
      let settledCount = 0;
      let resolved = false;
      const stage1Start = Date.now();

      const finish = () => {
        if (!resolved) {
          resolved = true;
          resolveStage1(undefined);
        }
      };

      const checkEarlyCutoff = () => {
        if (resolved) return;
        if (sawNotLoggedIn) {
          finish();
          return;
        }
        let healthyCount = 0;
        for (const res of stage1Map.values()) {
          if (res.ok) healthyCount++;
        }
        const mustWaitDone = mustWaitOrigins.every((d) => stage1Map.has(d));
        const elapsed = Date.now() - stage1Start;
        if (healthyCount >= 3 && (mustWaitDone || elapsed >= STAGE1_EARLY_CUTOFF_MS)) {
          finish();
        }
      };

      const cutoffTimer = setTimeout(checkEarlyCutoff, STAGE1_EARLY_CUTOFF_MS);
      const maxTimer = setTimeout(finish, STAGE1_PROBE_TIMEOUT_MS + 100);

      for (const origin of pool) {
        probeDomainOnce(origin, STAGE1_PROBE_TIMEOUT_MS).then((res) => {
          stage1Map.set(origin, res);
          if (res.notLoggedIn) sawNotLoggedIn = true;
          settledCount++;
          checkEarlyCutoff();
          if (settledCount >= pool.length) {
            clearTimeout(cutoffTimer);
            clearTimeout(maxTimer);
            finish();
          }
        });
      }
    });

    // If the user has no session.json yet, fall back to `zlib doctor --json`
    // so `check()` can sign in on a reachable domain first.
    if (sawNotLoggedIn) {
      const healthy = await discoverHealthyViaDoctor(state, failedHosts);
      if (healthy.length === 0) return null;
      const chosen =
        (userPreferredDomain && healthy.includes(userPreferredDomain) ? userPreferredDomain : "") ||
        (state.activeDomain && healthy.includes(state.activeDomain) ? state.activeDomain : "") ||
        healthy[0];
      state.activeDomain = chosen;
      state.backupDomains = healthy.filter((d) => d !== chosen).slice(0, 3);
      state.lastProbeAt = Date.now();
      await saveDomainState(state);
      return chosen;
    }

    const stage1Healthy = [...stage1Map.values()]
      .filter((r) => r.ok)
      .sort((a, b) => a.rtt - b.rtt);

    if (stage1Healthy.length === 0) {
      const doctorHealthy = await discoverHealthyViaDoctor(state, failedHosts);
      if (doctorHealthy.length === 0) return null;
      const chosen = doctorHealthy[0];
      state.activeDomain = chosen;
      state.backupDomains = doctorHealthy.slice(1, 4);
      state.lastProbeAt = Date.now();
      await saveDomainState(state);
      return chosen;
    }

    // Select finalists for Stage 2: Top 3 fastest + userPreferredDomain + activeDomain.
    /** @type {string[]} */
    const finalists = [];
    for (const item of stage1Healthy.slice(0, 3)) {
      if (!finalists.includes(item.origin)) finalists.push(item.origin);
    }
    for (const special of [userPreferredDomain, state.activeDomain]) {
      if (special && stage1Map.get(special)?.ok && !finalists.includes(special)) {
        finalists.push(special);
      }
    }

    // Stage 2: 2 additional rounds on finalists (total 3 samples per finalist).
    const round2Results = await Promise.all(
      finalists.map((origin) => probeDomainOnce(origin, STAGE2_PROBE_TIMEOUT_MS))
    );
    const round3Results = await Promise.all(
      finalists.map((origin) => probeDomainOnce(origin, STAGE2_PROBE_TIMEOUT_MS))
    );

    /** @type {DomainProbeStats[]} */
    const statsList = finalists.map((origin, idx) => {
      const samples = [stage1Map.get(origin), round2Results[idx], round3Results[idx]].filter(Boolean);
      const okSamples = samples.filter((s) => s && s.ok);
      const successes = okSamples.length;
      const totalRtt = okSamples.reduce((acc, s) => acc + (s ? s.rtt : 0), 0);
      const maxRtt = okSamples.reduce((max, s) => Math.max(max, s ? s.rtt : 0), 0);
      return {
        origin,
        successes,
        attempts: samples.length,
        avgRtt: successes > 0 ? Math.round(totalRtt / successes) : Infinity,
        maxRtt: successes > 0 ? maxRtt : Infinity,
      };
    });

    const { chosen, fastest, backups } = selectBestDomain({
      statsList,
      userPreferredDomain,
      currentActiveDomain: state.activeDomain,
    });

    if (!chosen) return null;

    state.activeDomain = chosen;
    state.backupDomains = backups;
    state.lastProbeAt = Date.now();

    if (reason === "startup") {
      state.noBetterCount = 0;
    } else if (reason === "slow") {
      const switchedToFaster =
        chosen !== previousActive && fastest !== null && fastest.avgRtt < MAX_ACCEPTABLE_USER_RTT_MS;
      state.noBetterCount = switchedToFaster ? 0 : Math.min((state.noBetterCount || 0) + 1, 4);
    } else if (reason === "failure" && chosen !== previousActive) {
      state.noBetterCount = 0;
    }

    await saveDomainState(state);
    return chosen;
  })();

  activeEvaluationPromise = runPromise;
  try {
    return await runPromise;
  } finally {
    if (activeEvaluationPromise === runPromise) {
      activeEvaluationPromise = null;
    }
  }
}

/**
 * Checks whether a slow-request (>8s) background probe is allowed under the
 * exponential backoff cooldown (5m -> 10m -> 20m -> 40m -> 60m).
 * @param {DomainState} state
 * @returns {boolean}
 */
function canTriggerSlowProbe(state) {
  if (!state.lastProbeAt) return true;
  const factor = 2 ** Math.min(Math.max(state.noBetterCount || 0, 0), 4);
  const cooldownMs = Math.min(BASE_SLOW_COOLDOWN_MS * factor, MAX_SLOW_COOLDOWN_MS);
  return Date.now() - state.lastProbeAt >= cooldownMs;
}

/**
 * Picks a replacement domain when a request times out or fails with EXIT_NETWORK.
 * Uses cached backupDomains immediately if a probe ran within the last 60s,
 * otherwise runs a fresh two-stage evaluation.
 * @param {Set<string>} failedHosts
 * @param {Promise<string | null> | null} hedgedProbePromise
 * @returns {Promise<string | null>}
 */
async function resolveFailoverDomain(failedHosts, hedgedProbePromise) {
  if (hedgedProbePromise) {
    const hedged = await hedgedProbePromise;
    if (hedged && !failedHosts.has(extractHost(hedged))) {
      return hedged;
    }
  }

  const state = await loadDomainState();
  const recentProbe = state.lastProbeAt > 0 && Date.now() - state.lastProbeAt < RECENT_PROBE_FAILOVER_WINDOW_MS;
  if (recentProbe && state.backupDomains.length > 0) {
    const backup = state.backupDomains.find((d) => !failedHosts.has(extractHost(d)));
    if (backup) {
      state.activeDomain = backup;
      state.backupDomains = state.backupDomains.filter((d) => d !== backup);
      await saveDomainState(state);
      return backup;
    }
  }

  return evaluateAndSelectDomain({ failedHosts, reason: "failure" });
}

/**
 * Runs zlib with 8s hedged slow-domain probing, exponential backoff cooldown,
 * and automatic 15s failover retry on network or timeout errors.
 * @param {string[]} args
 * @param {Dalibre.ExecOptions} [options]
 * @returns {Promise<Dalibre.ExecResult>}
 */
async function execZlib(args, options = {}) {
  const totalTimeout = options.timeout ?? 60000;
  const isMetadataCall = totalTimeout <= 60000;
  const initialTimeout = isMetadataCall ? Math.min(totalTimeout, INITIAL_REQUEST_TIMEOUT_MS) : totalTimeout;
  const state = await loadDomainState();
  const domainUsed = state.activeDomain || state.configuredDomain || state.envDomain;

  /** @type {Promise<string | null> | null} */
  let hedgedProbePromise = null;
  /** @type { ReturnType<typeof setTimeout> | null } */
  let slowTimer = null;

  if (isMetadataCall && initialTimeout > SLOW_REQUEST_THRESHOLD_MS && canTriggerSlowProbe(state)) {
    slowTimer = setTimeout(() => {
      hedgedProbePromise = evaluateAndSelectDomain({ reason: "slow" }).catch(() => null);
    }, SLOW_REQUEST_THRESHOLD_MS);
  }

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
  } finally {
    if (slowTimer) clearTimeout(slowTimer);
  }

  if (firstResult && !isDomainFailure(firstResult)) {
    if (hedgedProbePromise) {
      // Allow an already-running hedged probe a brief window to persist its result
      // before Dalibre's invoke() cancels the call context on return.
      await Promise.race([hedgedProbePromise, sleep(2500)]);
    }
    return firstResult;
  }

  const output = firstResult ? `${firstResult.stderr || ""}\n${firstResult.stdout || ""}` : "";
  const failedHosts = extractFailedHosts(domainUsed, output);
  const newDomain = await resolveFailoverDomain(failedHosts, hedgedProbePromise);

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
 * Called when the plugin loads: evaluates candidate mirrors to pick the
 * optimal domain, then verifies or completes Z-Library sign-in.
 */
export async function check() {
  await evaluateAndSelectDomain({ reason: "startup" });
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
  // Once a fresh session.json is created, run the 3-round evaluation so the
  // fastest packet-loss-free domain is selected.
  await evaluateAndSelectDomain({ reason: "startup" });
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
