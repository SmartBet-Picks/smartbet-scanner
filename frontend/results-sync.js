/**
 * SmartBet unified results sync (Shopify frontend)
 *
 * Source of truth: /results-summary
 * No frontend calculations are performed.
 */
(function () {
  const API_BASE = window.SMARTBET_API_BASE || "https://smartbet-scanner-production.up.railway.app";
  const SUMMARY_ENDPOINT = `${API_BASE}/results-summary`;

  const NUMERIC_KEYS = ["profit", "roi", "win_rate", "wins", "losses", "total_graded"];

  function toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function normalizeSummary(raw) {
    const summary = raw && typeof raw === "object" ? raw : {};
    return {
      profit: toNumber(summary.profit),
      roi: toNumber(summary.roi),
      win_rate: toNumber(summary.win_rate),
      wins: Math.trunc(toNumber(summary.wins)),
      losses: Math.trunc(toNumber(summary.losses)),
      total_graded: Math.trunc(toNumber(summary.total_graded))
    };
  }

  function formatMetric(key, value) {
    switch (key) {
      case "profit":
        return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
      case "roi":
      case "win_rate":
        return `${value.toFixed(1)}%`;
      default:
        return String(Math.trunc(value));
    }
  }

  function setMetricValue(container, key, value) {
    const nodes = container.querySelectorAll(`[data-metric="${key}"]`);
    nodes.forEach((node) => {
      node.textContent = formatMetric(key, value);
      node.setAttribute("data-raw", String(value));
    });
  }

  function paintSummaryEverywhere(summary) {
    const blocks = document.querySelectorAll(
      "[data-results-summary='homepage'], [data-results-summary='vip-dashboard'], [data-results-summary='results-dashboard']"
    );

    blocks.forEach((block) => {
      NUMERIC_KEYS.forEach((key) => {
        setMetricValue(block, key, summary[key]);
      });
    });
  }

  async function fetchSummary() {
    const response = await fetch(SUMMARY_ENDPOINT, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`results-summary request failed (${response.status})`);
    }

    return response.json();
  }

  async function sync() {
    try {
      const raw = await fetchSummary();
      const summary = normalizeSummary(raw);
      paintSummaryEverywhere(summary);
      window.smartbetResultsSummary = summary;
    } catch (err) {
      console.error("SmartBet results sync failed:", err);
    }
  }

  window.syncSmartBetResultsSummary = sync;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sync);
  } else {
    sync();
  }
})();
