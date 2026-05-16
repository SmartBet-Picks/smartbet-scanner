/**
 * SmartBet unified frontend sync (Shopify frontend)
 *
 * Backend source of truth endpoints:
 * - /
 * - /results-summary
 * - /trend-summary
 *
 * No frontend calculations are performed.
 */
(function () {
  const API_BASE = window.SMARTBET_API_BASE || "https://smartbet-scanner-production.up.railway.app";
  const ENDPOINTS = {
    health: `${API_BASE}/`,
    resultsSummary: `${API_BASE}/results-summary`,
    trendSummary: `${API_BASE}/trend-summary`
  };

  const NUMERIC_KEYS = ["profit", "roi", "win_rate", "wins", "losses", "total_graded"];

  function toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function toInteger(value, fallback = 0) {
    return Math.trunc(toNumber(value, fallback));
  }

  function asObject(value) {
    return value && typeof value === "object" ? value : {};
  }

  function normalizeResultsSummary(raw) {
    const summary = asObject(raw);
    return {
      profit: toNumber(summary.profit),
      roi: toNumber(summary.roi),
      win_rate: toNumber(summary.win_rate),
      wins: toInteger(summary.wins),
      losses: toInteger(summary.losses),
      total_graded: toInteger(summary.total_graded)
    };
  }

  function normalizeTrendSummary(raw) {
    const trend = asObject(raw);
    return {
      streak_direction: String(trend.streak_direction || "flat"),
      streak_count: toInteger(trend.streak_count),
      last_7_win_rate: toNumber(trend.last_7_win_rate),
      momentum_score: toNumber(trend.momentum_score),
      trend_label: String(trend.trend_label || "Stable"),
      trend_confidence: toNumber(trend.trend_confidence)
    };
  }

  function formatMetric(key, value) {
    switch (key) {
      case "profit":
        return `${value < 0 ? "-" : ""}$${Math.abs(toNumber(value)).toFixed(2)}`;
      case "roi":
      case "win_rate":
      case "last_7_win_rate":
      case "trend_confidence":
        return `${toNumber(value).toFixed(1)}%`;
      case "momentum_score":
        return toNumber(value).toFixed(2);
      default:
        return String(toInteger(value));
    }
  }

  function setNodesValue(selector, key, value) {
    const nodes = document.querySelectorAll(selector);
    nodes.forEach((node) => {
      node.textContent = formatMetric(key, value);
      node.setAttribute("data-raw", String(value));
      node.removeAttribute("data-loading");
    });
  }

  function setText(selector, value) {
    const nodes = document.querySelectorAll(selector);
    nodes.forEach((node) => {
      node.textContent = value;
      node.removeAttribute("data-loading");
    });
  }

  function setSectionStatus(sectionSelector, status) {
    const sections = document.querySelectorAll(sectionSelector);
    sections.forEach((section) => {
      section.setAttribute("data-fetch-status", status);
      if (status === "ready" || status === "error") {
        section.classList.remove("is-loading");
      }
    });
  }

  function paintResultsSummary(summary) {
    const blocks = document.querySelectorAll(
      "[data-results-summary='homepage'], [data-results-summary='vip-dashboard'], [data-results-summary='results-dashboard']"
    );

    blocks.forEach((block) => {
      NUMERIC_KEYS.forEach((key) => {
        const nodes = block.querySelectorAll(`[data-metric=\"${key}\"]`);
        nodes.forEach((node) => {
          node.textContent = formatMetric(key, summary[key]);
          node.setAttribute("data-raw", String(summary[key]));
          node.removeAttribute("data-loading");
        });
      });
      block.setAttribute("data-fetch-status", "ready");
      block.classList.remove("is-loading");
    });

    // Defensive aliases often used in Shopify cards
    setNodesValue("[data-live-results-proof][data-metric='win_rate']", "win_rate", summary.win_rate);
    setNodesValue("[data-live-results-proof][data-metric='roi']", "roi", summary.roi);
    setNodesValue("[data-live-results-proof][data-metric='profit']", "profit", summary.profit);
  }

  function paintTrendSummary(trend) {
    setText("[data-trend-summary][data-field='streak_direction']", trend.streak_direction);
    setNodesValue("[data-trend-summary][data-metric='streak_count']", "streak_count", trend.streak_count);
    setNodesValue("[data-trend-summary][data-metric='last_7_win_rate']", "last_7_win_rate", trend.last_7_win_rate);
    setNodesValue("[data-trend-summary][data-metric='momentum_score']", "momentum_score", trend.momentum_score);
    setText("[data-trend-summary][data-field='trend_label']", trend.trend_label);
    setNodesValue("[data-trend-summary][data-metric='trend_confidence']", "trend_confidence", trend.trend_confidence);

    setSectionStatus("[data-trend-summary]", "ready");
  }

  async function fetchJSON(endpoint, timeoutMs = 12000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }

      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function sync() {
    setSectionStatus("[data-results-summary]", "loading");
    setSectionStatus("[data-trend-summary]", "loading");

    const tasks = {
      health: fetchJSON(ENDPOINTS.health).catch((error) => ({ __error: error })),
      resultsSummary: fetchJSON(ENDPOINTS.resultsSummary).catch((error) => ({ __error: error })),
      trendSummary: fetchJSON(ENDPOINTS.trendSummary).catch((error) => ({ __error: error }))
    };

    const [healthRaw, resultsRaw, trendRaw] = await Promise.all([
      tasks.health,
      tasks.resultsSummary,
      tasks.trendSummary
    ]);

    if (!healthRaw || healthRaw.__error) {
      console.warn("SmartBet health endpoint unavailable", healthRaw && healthRaw.__error);
    }

    if (resultsRaw && !resultsRaw.__error) {
      const summary = normalizeResultsSummary(resultsRaw);
      paintResultsSummary(summary);
      setSectionStatus("[data-results-summary]", "ready");
      window.smartbetResultsSummary = summary;
    } else {
      setSectionStatus("[data-results-summary]", "error");
      console.error("SmartBet results-summary sync failed:", resultsRaw && resultsRaw.__error);
    }

    if (trendRaw && !trendRaw.__error) {
      const trend = normalizeTrendSummary(trendRaw);
      paintTrendSummary(trend);
      window.smartbetTrendSummary = trend;
    } else {
      setSectionStatus("[data-trend-summary]", "error");
      console.error("SmartBet trend-summary sync failed:", trendRaw && trendRaw.__error);
    }
  }

  window.syncSmartBetResultsSummary = sync;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sync, { once: true });
  } else {
    sync();
  }
})();
