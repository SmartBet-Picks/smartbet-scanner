require("dotenv").config();
const fetch = require("node-fetch");

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const BOOKMAKER_KEY = "draftkings";
const REGIONS = "us";
const MARKETS = "h2h";
const ODDS_FORMAT = "american";
const DEFAULT_STAKE = 10;

const SPORTS = [
  { key: "baseball_mlb", label: "MLB" },
  { key: "basketball_nba", label: "NBA" },
  { key: "americanfootball_nfl", label: "NFL" },
  { key: "mma_mixed_martial_arts", label: "UFC" }
];

function nowISO() {
  return new Date().toISOString();
}

function toDateOnly(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function normalizeTeam(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function americanToImpliedProbability(odds) {
  const n = Number(odds);
  if (!Number.isFinite(n) || n === 0) return null;
  if (n < 0) return Math.abs(n) / (Math.abs(n) + 100);
  return 100 / (n + 100);
}

function americanProfit(odds, stake = DEFAULT_STAKE) {
  const n = Number(odds);
  if (!Number.isFinite(n) || n === 0) return 0;
  if (n > 0) return stake * (n / 100);
  return stake * (100 / Math.abs(n));
}

function calculateEdge(impliedProbability, confidence) {
  if (impliedProbability == null || confidence == null) return null;
  const modelProbability = Number(confidence) / 100;
  return Number(((modelProbability - impliedProbability) * 100).toFixed(2));
}

function calculateExpectedValue(odds, confidence) {
  const n = Number(odds);
  const c = Number(confidence);

  if (!Number.isFinite(n) || !Number.isFinite(c)) return null;

  const decimalOdds =
    n > 0
      ? n / 100 + 1
      : 100 / Math.abs(n) + 1;

  const winProbability = c / 100;

  const expectedValue =
    winProbability * (decimalOdds - 1) - (1 - winProbability);

  return Number(expectedValue.toFixed(3));
}

function getRiskLabel(confidence, odds) {
  if (confidence >= 80 && odds <= -110 && odds >= -220) return "Low";
  if (confidence >= 72) return "Medium";
  return "High";
}

function getMarketConfidence(impliedProbability, odds) {
  if (impliedProbability == null) return "Unknown";
  if (impliedProbability >= 0.62 && odds < 0) return "Strong Market";
  if (impliedProbability >= 0.52) return "Balanced Market";
  if (odds > 130) return "Underdog Market";
  return "Volatile Market";
}

function getVolatility(odds, impliedProbability) {
  if (odds >= 180) return "High";
  if (odds >= 120) return "Medium-High";
  if (impliedProbability && impliedProbability >= 0.62) return "Low";
  return "Medium";
}

function getTrapWarning({ odds, impliedProbability, confidence, edge, expectedValue }) {
  if (odds <= -260) return "Heavy favorite blocked";
  if (expectedValue != null && expectedValue < 0) return "Negative EV warning";
  if (edge != null && edge < 3) return "Low edge warning";
  if (odds < -220 && confidence < 78) return "Heavy favorite risk";
  if (odds > 170 && confidence < 78) return "Longshot volatility";
  if (impliedProbability && impliedProbability > 0.7 && confidence < 78) {
    return "Public favorite caution";
  }
  return "None";
}

function getHoursUntilGame(commenceTime) {
  if (!commenceTime) return null;
  const gameTime = new Date(commenceTime);
  if (Number.isNaN(gameTime.getTime())) return null;

  const now = new Date();
  const diffMs = gameTime.getTime() - now.getTime();
  return Number((diffMs / (1000 * 60 * 60)).toFixed(2));
}

function getEventTimeLabel(hoursUntilGame) {
  if (hoursUntilGame == null) return "Upcoming";
  if (hoursUntilGame < 0) return "Started / Pending Grade";
  if (hoursUntilGame <= 12) return "Starts Tonight";
  if (hoursUntilGame <= 24) return "Starts Tomorrow";
  return "Early Market Value";
}

function getTimingFlags(commenceTime) {
  const hoursUntilGame = getHoursUntilGame(commenceTime);
  const todayPlay =
    hoursUntilGame != null &&
    hoursUntilGame >= 0 &&
    hoursUntilGame <= 24;

  const earlyValue =
    hoursUntilGame != null &&
    hoursUntilGame > 24;

  return {
    today_play: todayPlay,
    early_value: earlyValue,
    hours_until_game: hoursUntilGame,
    event_time_label: getEventTimeLabel(hoursUntilGame)
  };
}

function confidenceEngineV2({ odds, homeTeam, teamName }) {
  const implied = americanToImpliedProbability(odds);
  let confidence = 60;

  if (implied != null) confidence += Math.min(18, implied * 20);
  if (odds < 0) confidence += 5;
  if (odds <= -160) confidence += 3;
  if (odds <= -260) confidence -= 8;
  if (odds >= 120) confidence -= 3;
  if (odds >= 180) confidence -= 6;

  const isHome = normalizeTeam(teamName) === normalizeTeam(homeTeam);
  if (isHome) confidence += 3;

  confidence = Math.max(45, Math.min(92, confidence));
  return Number(confidence.toFixed(1));
}

function passesEVFilter(pick) {

  const odds = Number(pick.odds || 0);
  const confidence = Number(pick.confidence || 0);
  const edge = Number(pick.edge || 0);
  const ev = Number(pick.expected_value || 0);

  if (!Number.isFinite(odds)) return false;
  if (!Number.isFinite(confidence)) return false;

  /*
    CORE FILTERS
  */

  if (confidence < 75) return false;

  if (edge < 5) return false;

  if (ev < 0.08) return false;

  /*
    FAVORITE CONTROL
  */

  if (odds <= -220) return false;

  if (odds <= -180 && confidence < 80) return false;

  /*
    UNDERDOG CONTROL
  */

  if (odds >= 160 && confidence < 80) return false;

  /*
    MLB TIGHTENING
  */

  if (
    pick.sport === "MLB" &&
    odds <= -170 &&
    edge < 7
  ) {
    return false;
  }

  /*
    VOLATILITY FILTER
  */

  if (
    pick.volatility === "High" &&
    confidence < 82
  ) {
    return false;
  }

  /*
    TRAP WARNING FILTER
  */

  if (
    pick.trap_warning &&
    pick.trap_warning !== "None"
  ) {
    return false;
  }

  return true;
}

function assignSections(picks) {
  const sorted = [...picks].sort((a, b) => {
    const evDiff = Number(b.expected_value || 0) - Number(a.expected_value || 0);
    if (evDiff !== 0) return evDiff;

    const edgeDiff = Number(b.edge || 0) - Number(a.edge || 0);
    if (edgeDiff !== 0) return edgeDiff;

    return Number(b.confidence || 0) - Number(a.confidence || 0);
  });

  return sorted.map((pick, index) => {
    let section = "Aggressive Slip";

    if (index < 5) section = "Top 5 Locks";
    else if (
      pick.confidence >= 76 &&
      pick.expected_value >= 0 &&
      pick.volatility !== "High"
    ) {
      section = "Safe Slip";
    } else if (pick.confidence >= 70) {
      section = "Balanced Slip";
    }

    if (index === 0) section = "Free Pick";

    return { ...pick, section };
  });
}

function uniqueByGameBestSide(picks) {
  const gameMap = new Map();

  for (const p of picks) {
    const gameKey = [
  p.sport,
  toDateOnly(p.commence_time),
  normalizeTeam(p.home_team),
  normalizeTeam(p.away_team)
].join("|");

    const existing = gameMap.get(gameKey);

    if (!existing) {
      gameMap.set(gameKey, p);
      continue;
    }

    const currentScore =
      Number(p.expected_value || 0) * 100 +
      Number(p.edge || 0) * 2 +
      Number(p.confidence || 0);

    const existingScore =
      Number(existing.expected_value || 0) * 100 +
      Number(existing.edge || 0) * 2 +
      Number(existing.confidence || 0);

    if (currentScore > existingScore) {
      gameMap.set(gameKey, p);
    }
  }

  return Array.from(gameMap.values());
}

function smartbetGameWindowHours(sportKey) {
  if (sportKey === "mma_mixed_martial_arts") return 14 * 24;
  if (sportKey === "americanfootball_nfl") return 7 * 24;
  return 72;
}

function smartbetIsNFLInPlayableWindow(gameTime) {
  const month = gameTime.getUTCMonth() + 1;
  return [1, 2, 8, 9, 10, 11, 12].includes(month);
}

function smartbetLooksLikeFuturesMarket(game) {
  const text = [
    game?.home_team,
    game?.away_team,
    game?.name,
    game?.description,
    game?.title
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const bannedWords = [
    "super bowl winner",
    "championship",
    "conference winner",
    "division winner",
    "regular season wins",
    "to win",
    "mvp",
    "rookie of the year",
    "cy young",
    "heisman",
    "draft",
    "playoffs yes",
    "playoffs no"
  ];

  return bannedWords.some(word => text.includes(word));
}

function smartbetIsValidScannerGame(game, sportKey) {
  if (!game || !game.commence_time) return false;
  if (!game.home_team || !game.away_team) return false;
  if (smartbetLooksLikeFuturesMarket(game)) return false;

  const gameTime = new Date(game.commence_time);
  if (Number.isNaN(gameTime.getTime())) return false;

  const now = new Date();
  const minTime = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const maxTime = new Date(
    now.getTime() + smartbetGameWindowHours(sportKey) * 60 * 60 * 1000
  );

  if (gameTime < minTime) return false;
  if (gameTime > maxTime) return false;

  if (sportKey === "americanfootball_nfl" && !smartbetIsNFLInPlayableWindow(gameTime)) {
    return false;
  }

  return true;
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();

  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${text}`);

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON: ${text}`);
  }
}

async function insertPickHistoryIfMissing(pick) {
  const { data: existing } = await supabase
    .from("pick_history")
    .select("id")
    .eq("sport", pick.sport)
    .eq("team_name", pick.team_name)
    .eq("home_team", pick.home_team)
    .eq("away_team", pick.away_team)
    .eq("commence_time", pick.commence_time)
    .limit(1);

  if (existing && existing.length > 0) return;

  await supabase.from("pick_history").insert([pick]);
}

app.get("/", (req, res) => {
  res.json({
    status: "SmartBet Railway backend running",
    stack: "Shopify + Railway + Supabase + Odds API",
    bookmaker: "DraftKings only",
    market: "Moneyline",
    engine: "Confidence Engine V2.6 + EV Filter Phase 1 + Today/Early Value Split",
    routes: [
      "/",
      "/scan",
      "/grade",
      "/results-summary",
      "/analytics-summary",
      "/trend-summary",
      "/debug-scores",
      "/debug-pending"
    ],
    time: nowISO()
  });
});

app.get("/scan", async (req, res) => {
  try {
    const allPicks = [];
    const skippedGames = [];
    const filteredPicks = [];

    for (const sport of SPORTS) {
      const url =
        `https://api.the-odds-api.com/v4/sports/${sport.key}/odds` +
        `?apiKey=${ODDS_API_KEY}` +
        `&regions=${REGIONS}` +
        `&markets=${MARKETS}` +
        `&oddsFormat=${ODDS_FORMAT}` +
        `&bookmakers=${BOOKMAKER_KEY}`;

      const games = await fetchJson(url);

      for (const game of games || []) {
        if (!smartbetIsValidScannerGame(game, sport.key)) {
          skippedGames.push({
            sport: sport.label,
            game: `${game?.away_team || "Unknown"} @ ${game?.home_team || "Unknown"}`,
            commence_time: game?.commence_time || null,
            reason: "Filtered out: offseason, old, far-future, missing teams, or futures-style market"
          });
          continue;
        }

        const bookmaker = (game.bookmakers || []).find(b => b.key === BOOKMAKER_KEY);
        if (!bookmaker) continue;

        const market = (bookmaker.markets || []).find(m => m.key === MARKETS);
        if (!market || !market.outcomes) continue;

        for (const outcome of market.outcomes) {
          const teamName = outcome.name;
          const odds = Number(outcome.price);

          if (!teamName || !Number.isFinite(odds)) continue;

          const normalizedTeam = normalizeTeam(teamName);
          const validTeam =
            normalizedTeam === normalizeTeam(game.home_team) ||
            normalizedTeam === normalizeTeam(game.away_team);

          if (!validTeam) continue;

          const impliedRaw = americanToImpliedProbability(odds);

          const confidence = confidenceEngineV2({
            odds,
            homeTeam: game.home_team,
            teamName
          });

          const edge = calculateEdge(impliedRaw, confidence);
          const expectedValue = calculateExpectedValue(odds, confidence);
          const marketConfidence = getMarketConfidence(impliedRaw, odds);
          const volatility = getVolatility(odds, impliedRaw);

          const trapWarning = getTrapWarning({
            odds,
            impliedProbability: impliedRaw,
            confidence,
            edge,
            expectedValue
          });

          const timingFlags = getTimingFlags(game.commence_time);

          const pick = {
            sport: sport.label,
            sport_key: sport.key,
            event_id: game.id || null,
            game: `${game.away_team} @ ${game.home_team}`,
            home_team: game.home_team,
            away_team: game.away_team,
            team_name: teamName,
            pick: teamName,
            market: "Moneyline",
            bookmaker: "DraftKings",
            odds,
            implied_probability:
              impliedRaw == null ? null : Number((impliedRaw * 100).toFixed(2)),
            confidence,
            edge,
            expected_value: expectedValue,
            risk: getRiskLabel(confidence, odds),
            market_confidence: marketConfidence,
            volatility,
            trap_warning: trapWarning,
            commence_time: game.commence_time,
            game_date: toDateOnly(game.commence_time),
            today_play: timingFlags.today_play,
            early_value: timingFlags.early_value,
            hours_until_game: timingFlags.hours_until_game,
            event_time_label: timingFlags.event_time_label,
            status: "Pending",
            result: "Pending",
            actual_result: null,
            graded_at: null,
            created_at: nowISO(),
            updated_at: nowISO()
          };

          if (!passesEVFilter(pick)) {
            filteredPicks.push({
              sport: sport.label,
              game: pick.game,
              pick: pick.pick,
              odds: pick.odds,
              confidence: pick.confidence,
              edge: pick.edge,
              expected_value: pick.expected_value,
              today_play: pick.today_play,
              early_value: pick.early_value,
              hours_until_game: pick.hours_until_game,
              event_time_label: pick.event_time_label,
              reason: "Filtered out by EV/edge/favorite-trap rules"
            });
            continue;
          }

          allPicks.push(pick);
        }
      }
    }

    const finalPicks = assignSections(uniqueByGameBestSide(allPicks))
      .sort((a, b) => {
        const todayA = a.today_play ? 1 : 0;
        const todayB = b.today_play ? 1 : 0;

        if (todayB - todayA !== 0) return todayB - todayA;

        const evDiff = Number(b.expected_value || 0) - Number(a.expected_value || 0);
        if (evDiff !== 0) return evDiff;

        const edgeDiff = Number(b.edge || 0) - Number(a.edge || 0);
        if (edgeDiff !== 0) return edgeDiff;

        return Number(b.confidence || 0) - Number(a.confidence || 0);
      })
      .slice(0, 40);

    await supabase.from("picks").delete().neq("id", 0);

    if (finalPicks.length > 0) {
      const { error } = await supabase.from("picks").insert(finalPicks);
      if (error) throw error;

      for (const pick of finalPicks) {
        await insertPickHistoryIfMissing(pick);
      }
    }

    res.json({
      success: true,
      message: "Clean EV scan complete with Today’s Top Plays + Early Value Plays",
      filter_note:
        "NFL is enabled, UFC is enabled, and future UFC picks are labeled Early Value. Offseason/futures/far-future markets remain blocked. EV filter blocks weak favorites, negative EV, low edge, and low-confidence plays.",
      bookmaker: "DraftKings",
      market: "Moneyline",
      total_saved: finalPicks.length,
      today_top_plays_count: finalPicks.filter(p => p.today_play).length,
      early_value_plays_count: finalPicks.filter(p => p.early_value).length,
      skipped_games_count: skippedGames.length,
      ev_filtered_picks_count: filteredPicks.length,
      top_5_count: finalPicks.filter(p => p.section === "Top 5 Locks").length,
      free_pick_count: finalPicks.filter(p => p.section === "Free Pick").length,
      time: nowISO(),
      picks: finalPicks,
      today_top_plays: finalPicks.filter(p => p.today_play),
      early_value_plays: finalPicks.filter(p => p.early_value),
      skipped_games: skippedGames.slice(0, 25),
      ev_filtered_picks: filteredPicks.slice(0, 25)
    });
  } catch (error) {
    console.error("SCAN ERROR:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/grade", async (req, res) => {
  try {
    const { data: pending, error } = await supabase
      .from("pick_history")
      .select("*")
      .or("status.eq.Pending,result.eq.Pending")
      .not("commence_time", "is", null);

    if (error) throw error;

    const now = new Date();
    const graded = [];
    const skipped = [];

    for (const pick of pending || []) {
      const commence = new Date(pick.commence_time);

      if (commence > now) {
        skipped.push({
          id: pick.id,
          reason: "Future game - not graded early",
          game: pick.game,
          commence_time: pick.commence_time
        });
        continue;
      }

      const sportConfig = SPORTS.find(s => s.label === pick.sport || s.key === pick.sport_key);
      if (!sportConfig) {
        skipped.push({ id: pick.id, reason: "Unknown sport", game: pick.game });
        continue;
      }

      const url =
        `https://api.the-odds-api.com/v4/sports/${sportConfig.key}/scores` +
        `?apiKey=${ODDS_API_KEY}` +
        `&daysFrom=3`;

      const scores = await fetchJson(url);
      const pickDate = toDateOnly(pick.commence_time);

      const match = (scores || []).find(game => {
        const sameDate = toDateOnly(game.commence_time) === pickDate;
        const sameHome = normalizeTeam(game.home_team) === normalizeTeam(pick.home_team);
        const sameAway = normalizeTeam(game.away_team) === normalizeTeam(pick.away_team);
        return sameDate && sameHome && sameAway;
      });

      if (!match) {
        skipped.push({
          id: pick.id,
          reason: "No exact game-date match found",
          game: pick.game,
          commence_time: pick.commence_time
        });
        continue;
      }

      if (!match.completed) {
        skipped.push({
          id: pick.id,
          reason: "Game not completed",
          game: pick.game,
          commence_time: pick.commence_time
        });
        continue;
      }

      const scoresArr = match.scores || [];
      if (scoresArr.length < 2) {
        skipped.push({ id: pick.id, reason: "Scores missing", game: pick.game });
        continue;
      }

      const teamScore = scoresArr.find(
        s => normalizeTeam(s.name) === normalizeTeam(pick.team_name)
      );

      const opponentScore = scoresArr.find(
        s => normalizeTeam(s.name) !== normalizeTeam(pick.team_name)
      );

      if (!teamScore || !opponentScore) {
        skipped.push({ id: pick.id, reason: "Team score not matched", game: pick.game });
        continue;
      }

      const teamPoints = Number(teamScore.score);
      const oppPoints = Number(opponentScore.score);

      if (!Number.isFinite(teamPoints) || !Number.isFinite(oppPoints)) {
        skipped.push({ id: pick.id, reason: "Invalid score values", game: pick.game });
        continue;
      }

      const won = teamPoints > oppPoints;
      const actualResult = `${teamScore.name} ${teamPoints} - ${opponentScore.name} ${oppPoints}`;

      const updatePayload = {
        status: won ? "Win" : "Loss",
        result: won ? "Win" : "Loss",
        actual_result: actualResult,
        graded_at: nowISO(),
        updated_at: nowISO()
      };

      const { error: updateError } = await supabase
        .from("pick_history")
        .update(updatePayload)
        .eq("id", pick.id);

      if (updateError) throw updateError;

      await supabase
        .from("picks")
        .update(updatePayload)
        .eq("team_name", pick.team_name)
        .eq("home_team", pick.home_team)
        .eq("away_team", pick.away_team)
        .eq("commence_time", pick.commence_time);

      graded.push({
        id: pick.id,
        game: pick.game,
        pick: pick.team_name,
        result: won ? "Win" : "Loss",
        actual_result: actualResult
      });
    }

    res.json({
      success: true,
      message: "Grading complete",
      graded_count: graded.length,
      skipped_count: skipped.length,
      graded,
      skipped,
      time: nowISO()
    });
  } catch (error) {
    console.error("GRADE ERROR:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/results-summary", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("pick_history")
      .select("*")
      .in("result", ["Win", "Loss"])
      .order("graded_at", { ascending: false })
      .limit(500);

    if (error) throw error;

    const unique = [];
    const seen = new Set();

    for (const p of data || []) {
      const key = [
        p.sport,
        p.game_date || toDateOnly(p.commence_time),
        normalizeTeam(p.home_team),
        normalizeTeam(p.away_team),
        normalizeTeam(p.team_name)
      ].join("|");

      if (!seen.has(key)) {
        seen.add(key);
        unique.push(p);
      }
    }

    let profit = 0;

    for (const p of unique) {
      if (p.result === "Win") profit += americanProfit(p.odds, DEFAULT_STAKE);
      if (p.result === "Loss") profit -= DEFAULT_STAKE;
    }

    const wins = unique.filter(p => p.result === "Win").length;
    const losses = unique.filter(p => p.result === "Loss").length;
    const total = wins + losses;
    const winRate = total ? Number(((wins / total) * 100).toFixed(1)) : 0;
    const roi = total ? Number(((profit / (total * DEFAULT_STAKE)) * 100).toFixed(1)) : 0;

    res.json({
      success: true,
      total,
      wins,
      losses,
      win_rate: winRate,
      profit: Number(profit.toFixed(2)),
      roi,
      recent_results: unique.slice(0, 50),
      last_updated: nowISO()
    });
  } catch (error) {
    console.error("RESULTS SUMMARY ERROR:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/analytics-summary", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("pick_history")
      .select("*")
      .in("result", ["Win", "Loss"])
      .order("graded_at", { ascending: false })
      .limit(500);

    if (error) throw error;

    const sectionAnalytics = {};
    const sportAnalytics = {};

    for (const p of data || []) {
      const section = p.section || "Unassigned";
      const sport = p.sport || "Unknown";

      if (!sectionAnalytics[section]) {
        sectionAnalytics[section] = {
          section,
          wins: 0,
          losses: 0,
          total: 0,
          win_rate: 0,
          profit: 0,
          roi: 0
        };
      }

      if (!sportAnalytics[sport]) {
        sportAnalytics[sport] = {
          sport,
          wins: 0,
          losses: 0,
          total: 0,
          win_rate: 0,
          profit: 0,
          roi: 0
        };
      }

      let pickProfit = 0;

      if (p.result === "Win") {
        pickProfit = americanProfit(p.odds, DEFAULT_STAKE);
        sectionAnalytics[section].wins++;
        sportAnalytics[sport].wins++;
      }

      if (p.result === "Loss") {
        pickProfit = -DEFAULT_STAKE;
        sectionAnalytics[section].losses++;
        sportAnalytics[sport].losses++;
      }

      sectionAnalytics[section].total++;
      sportAnalytics[sport].total++;

      sectionAnalytics[section].profit += pickProfit;
      sportAnalytics[sport].profit += pickProfit;
    }

    for (const key of Object.keys(sectionAnalytics)) {
      const x = sectionAnalytics[key];
      x.win_rate = x.total ? Number(((x.wins / x.total) * 100).toFixed(1)) : 0;
      x.profit = Number(x.profit.toFixed(2));
      x.roi = x.total ? Number(((x.profit / (x.total * DEFAULT_STAKE)) * 100).toFixed(1)) : 0;
    }

    for (const key of Object.keys(sportAnalytics)) {
      const x = sportAnalytics[key];
      x.win_rate = x.total ? Number(((x.wins / x.total) * 100).toFixed(1)) : 0;
      x.profit = Number(x.profit.toFixed(2));
      x.roi = x.total ? Number(((x.profit / (x.total * DEFAULT_STAKE)) * 100).toFixed(1)) : 0;
    }

    res.json({
      success: true,
      section_analytics: Object.values(sectionAnalytics),
      sport_analytics: Object.values(sportAnalytics),
      last_updated: nowISO()
    });
  } catch (error) {
    console.error("ANALYTICS SUMMARY ERROR:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/trend-summary", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("pick_history")
      .select("*")
      .in("result", ["Win", "Loss"])
      .order("graded_at", { ascending: false })
      .limit(500);

    if (error) throw error;

    const teamMap = {};

    for (const p of data || []) {
      const team = p.team_name || p.pick;
      if (!team) continue;

      if (!teamMap[team]) {
        teamMap[team] = {
          team_name: team,
          wins: 0,
          losses: 0,
          total: 0,
          win_rate: 0,
          profit: 0,
          roi: 0,
          recent_picks: []
        };
      }

      let pickProfit = 0;

      if (p.result === "Win") {
        pickProfit = americanProfit(p.odds, DEFAULT_STAKE);
        teamMap[team].wins++;
      }

      if (p.result === "Loss") {
        pickProfit = -DEFAULT_STAKE;
        teamMap[team].losses++;
      }

      teamMap[team].profit += pickProfit;
      teamMap[team].total++;

      teamMap[team].recent_picks.push({
        game: p.game,
        result: p.result,
        graded_at: p.graded_at,
        confidence: p.confidence,
        edge: p.edge,
        expected_value: p.expected_value
      });
    }

    const teams = Object.values(teamMap).map(t => ({
      ...t,
      win_rate: t.total ? Number(((t.wins / t.total) * 100).toFixed(1)) : 0,
      profit: Number(t.profit.toFixed(2)),
      roi: t.total ? Number(((t.profit / (t.total * DEFAULT_STAKE)) * 100).toFixed(1)) : 0
    }));

    const hottestTeams = teams
      .filter(t => t.total >= 2)
      .sort((a, b) => b.roi - a.roi || b.win_rate - a.win_rate || b.wins - a.wins)
      .slice(0, 10);

    const coldFadeTeams = teams
      .filter(t => t.total >= 2)
      .sort((a, b) => a.roi - b.roi || a.win_rate - b.win_rate || b.losses - a.losses)
      .slice(0, 10);

    const sharpestRecentPicks = (data || [])
      .filter(p => p.result === "Win")
      .sort((a, b) => {
        const evDiff = Number(b.expected_value || 0) - Number(a.expected_value || 0);
        if (evDiff !== 0) return evDiff;
        return Number(b.edge || 0) - Number(a.edge || 0);
      })
      .slice(0, 10);

    res.json({
      success: true,
      hottest_teams: hottestTeams,
      cold_fade_teams: coldFadeTeams,
      sharpest_recent_picks: sharpestRecentPicks,
      last_updated: nowISO()
    });
  } catch (error) {
    console.error("TREND SUMMARY ERROR:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/debug-pending", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("pick_history")
      .select("*")
      .or("status.eq.Pending,result.eq.Pending")
      .order("commence_time", { ascending: true })
      .limit(100);

    if (error) throw error;

    res.json({
      success: true,
      pending_count: data?.length || 0,
      pending: data || [],
      time: nowISO()
    });
  } catch (error) {
    console.error("DEBUG PENDING ERROR:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/debug-scores", async (req, res) => {
  try {
    const output = {};

    for (const sport of SPORTS) {
      const url =
        `https://api.the-odds-api.com/v4/sports/${sport.key}/scores` +
        `?apiKey=${ODDS_API_KEY}` +
        `&daysFrom=3`;

      const scores = await fetchJson(url);
      output[sport.label] = scores;
    }

    res.json({
      success: true,
      scores: output,
      time: nowISO()
    });
  } catch (error) {
    console.error("DEBUG SCORES ERROR:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`SmartBet backend running on port ${PORT}`);
});
