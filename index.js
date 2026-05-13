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

// Player props are pulled from The Odds API event-level endpoint:
// /v4/sports/{sport}/events/{eventId}/odds
// Keep this engine alongside the existing moneyline scanner.
const PLAYER_PROP_MARKETS = {
  basketball_nba: [
    "player_points",
    "player_rebounds",
    "player_assists",
    "player_points_rebounds_assists",
    "player_threes"
  ],
  baseball_mlb: [
    "batter_hits",
    "batter_total_bases",
    "pitcher_strikeouts",
    "pitcher_hits_allowed",
    "batter_rbis"
  ],
  americanfootball_nfl: [
    "player_pass_yds",
    "player_rush_yds",
    "player_reception_yds",
    "player_receptions",
    "player_anytime_td"
  ],
  mma_mixed_martial_arts: [
    "fighter_significant_strikes",
    "fighter_takedowns",
    "fight_goes_distance",
    "fighter_fantasy_score"
  ]
};

const PROP_MAX_PER_SCAN = 60;

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

  if (odds <= -260) return false;
  if (confidence < 70) return false;
  if (edge < 3) return false;
  if (ev < 0) return false;

  if (odds > 140 && confidence < 78) return false;
  if (odds <= -180 && confidence < 75) return false;

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

function uniqueByGameAndTeam(picks) {
  const seen = new Set();
  const out = [];

  for (const p of picks) {
    const key = [
      p.sport,
      toDateOnly(p.commence_time),
      normalizeTeam(p.home_team),
      normalizeTeam(p.away_team),
      normalizeTeam(p.team_name)
    ].join("|");

    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }

  return out;
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

function normalizePropType(marketKey) {
  const map = {
    player_points: "Points",
    player_rebounds: "Rebounds",
    player_assists: "Assists",
    player_points_rebounds_assists: "PRA",
    player_threes: "3PT Made",
    batter_hits: "Hits",
    batter_total_bases: "Total Bases",
    pitcher_strikeouts: "Strikeouts",
    pitcher_hits_allowed: "Hits Allowed",
    batter_rbis: "RBIs",
    player_pass_yds: "Passing Yards",
    player_rush_yds: "Rushing Yards",
    player_reception_yds: "Receiving Yards",
    player_receptions: "Receptions",
    player_anytime_td: "Anytime TD",
    fighter_significant_strikes: "Significant Strikes",
    fighter_takedowns: "Takedowns",
    fight_goes_distance: "Fight Goes Distance",
    fighter_fantasy_score: "Fantasy Score"
  };

  return map[marketKey] || marketKey;
}

function normalizeOutcomeSide(outcomeName) {
  const text = String(outcomeName || "").toLowerCase().trim();
  if (text === "over" || text.includes(" over")) return "Over";
  if (text === "under" || text.includes(" under")) return "Under";
  if (text === "yes") return "Yes";
  if (text === "no") return "No";
  return outcomeName || "Unknown";
}

function getPropPlayerName(outcome) {
  return outcome.description || outcome.name || "Unknown Player";
}

function propVolatility(marketKey, odds, line, side) {
  if (marketKey.includes("anytime_td")) return "High";
  if (marketKey.includes("fantasy")) return "High";
  if (marketKey.includes("fight_goes_distance")) return "Medium-High";
  if (odds >= 170) return "High";
  if (odds >= 130) return "Medium-High";
  if (odds <= -220) return "Medium-High";
  if (side === "Yes" || side === "No") return "Medium-High";
  return "Medium";
}

function sharpPropConfidence({ odds, line, marketKey, overUnder }) {
  const implied = americanToImpliedProbability(odds);
  let confidence = 61;

  if (implied != null) confidence += Math.min(18, implied * 22);

  // DraftKings prices near standard juice are usually better than heavy public tax.
  if (odds >= -145 && odds <= -105) confidence += 5;
  if (odds >= -110 && odds <= 120) confidence += 3;
  if (odds <= -180) confidence -= 5;
  if (odds <= -230) confidence -= 10;
  if (odds >= 150) confidence -= 7;

  // Unders and skill accumulation props tend to be less public-over driven.
  if (overUnder === "Under") confidence += 3;
  if (["player_rebounds", "player_assists", "player_receptions", "pitcher_strikeouts"].includes(marketKey)) confidence += 2;

  // TD/fantasy score style props are high variance and need stronger filtering.
  if (marketKey.includes("anytime_td")) confidence -= 7;
  if (marketKey.includes("fantasy")) confidence -= 5;

  // Very high raw lines are treated carefully without outside projections.
  if (Number(line) >= 35 && (marketKey.includes("points") || marketKey.includes("yds"))) confidence -= 3;

  confidence = Math.max(45, Math.min(94, confidence));
  return Number(confidence.toFixed(1));
}

function getPropMarketConfidence(impliedProbability, odds, edge) {
  if (edge >= 10 && odds >= -140 && odds <= 135) return "Strong Prop Edge";
  if (edge >= 6) return "Positive Prop Market";
  if (odds <= -200) return "Heavy Juice Market";
  if (odds >= 150) return "Volatile Plus Money";
  if (impliedProbability >= 0.55) return "Balanced Prop Market";
  return "Thin Prop Market";
}

function getPropTrapWarning({ odds, confidence, edge, expectedValue, volatility, marketKey, overUnder }) {
  if (expectedValue != null && expectedValue < 0) return "Negative EV warning";
  if (edge != null && edge < 3) return "Low edge warning";
  if (odds <= -230) return "Heavy juice prop blocked";
  if (odds >= 170 && confidence < 82) return "Longshot prop volatility";
  if (marketKey.includes("anytime_td") && confidence < 82) return "Public TD trap caution";
  if (overUnder === "Over" && odds <= -180 && confidence < 82) return "Overpriced public over";
  if (volatility === "High" && confidence < 80) return "High volatility caution";
  return "None";
}

function passesPropEVFilter(prop) {
  const odds = Number(prop.odds || 0);
  const confidence = Number(prop.confidence || 0);
  const edge = Number(prop.edge || 0);
  const ev = Number(prop.expected_value || 0);

  if (!Number.isFinite(odds) || !Number.isFinite(confidence)) return false;
  if (confidence < 70) return false;
  if (edge < 3) return false;
  if (ev < 0) return false;
  if (odds <= -230) return false;
  if (odds >= 170 && confidence < 82) return false;
  if (prop.volatility === "High" && confidence < 80) return false;
  if (prop.trap_warning !== "None" && confidence < 82) return false;

  return true;
}

function assignPropSections(props) {
  const sorted = [...props].sort((a, b) => {
    const evDiff = Number(b.expected_value || 0) - Number(a.expected_value || 0);
    if (evDiff !== 0) return evDiff;
    const edgeDiff = Number(b.edge || 0) - Number(a.edge || 0);
    if (edgeDiff !== 0) return edgeDiff;
    return Number(b.confidence || 0) - Number(a.confidence || 0);
  });

  return sorted.map((prop, index) => {
    let section = "Aggressive Prop Slip";

    if (index === 0) section = "Free Prop Pick";
    else if (index < 5) section = "Top 5 Props";
    else if (prop.confidence >= 80 && prop.volatility !== "High") section = "Safe Prop Slip";
    else if (prop.confidence >= 73) section = "Balanced Prop Slip";

    return { ...prop, section };
  });
}

function uniqueProps(props) {
  const seen = new Set();
  const out = [];

  for (const p of props) {
    const key = [
      p.sport,
      p.event_id,
      normalizeTeam(p.player_name),
      p.prop_market_key,
      p.over_under,
      p.line,
      p.odds
    ].join("|");

    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }

  return out;
}

async function insertPropHistoryIfMissing(prop) {
  const { data: existing } = await supabase
    .from("pick_history")
    .select("id")
    .eq("bet_type", "player_prop")
    .eq("event_id", prop.event_id)
    .eq("player_name", prop.player_name)
    .eq("prop_market_key", prop.prop_market_key)
    .eq("over_under", prop.over_under)
    .eq("line", prop.line)
    .limit(1);

  if (existing && existing.length > 0) return;
  await supabase.from("pick_history").insert([prop]);
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
    market: "Moneyline + Player Props",
    engine: "Confidence Engine V2.6 + EV Filter Phase 1 + Elite Player Props Engine",
    routes: [
      "/",
      "/scan",
      "/scan-props",
      "/grade",
      "/grade-props",
      "/results-summary",
      "/analytics-summary",
      "/trend-summary",
      "/debug-scores",
      "/debug-pending",
      "/debug-props"
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
            bet_type: "moneyline",
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

    const finalPicks = assignSections(uniqueByGameAndTeam(allPicks))
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

app.get("/debug-props", async (req, res) => {
  try {

    const { data, error } = await supabase
      .from("picks")
      .select("*")
      .eq("bet_type", "player_prop")
      .order("created_at", { ascending: false })
      .limit(25);

    if (error) {
      console.error("DEBUG PROPS ERROR:", error);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    res.json({
      success: true,
      props_count: data?.length || 0,
      props: data || [],
      time: nowISO()
    });

  } catch (error) {

    console.error("DEBUG PROPS CATCH:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });

  }
});

app.get("/scan-props", async (req, res) => {

  try {

    console.log("SCAN PROPS STARTED");

    const { data: insertedProps, error: insertError } = await supabase
      .from("picks")
      .insert([
        {
          sport: "MLB",
          game: "Demo Player Props",
          pick: "Aaron Judge Over 1.5 Hits",
          odds: -125,
          confidence: 78.5,
          edge: 18.2,
          expected_value: 0.34,
          market_confidence: "Balanced Market",
          volatility: "Medium",
          trap_warning: "None",
          section: "Balanced Prop Slip",
          bet_type: "player_prop",
          prop_type: "Hits",
          status: "Pending",
          event_time_label: "Starts Tonight",
          today_play: true,
          early_value: false,
          hours_until_game: 2.5,
          commence_time: new Date().toISOString(),
          created_at: new Date().toISOString()
        }
      ])
      .select();

    if (insertError) {

      console.error("SCAN PROPS INSERT ERROR:", insertError);

      return res.status(500).json({
        success: false,
        error: insertError.message
      });
    }

    console.log("SCAN PROPS SUCCESS");

    res.json({
      success: true,
      inserted: insertedProps?.length || 0,
      props: insertedProps || [],
      time: nowISO()
    });

  } catch (error) {

    console.error("SCAN PROPS CATCH:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });

  }

});

  

    const { data, error } =
      await supabase
        .from("picks")
        .select("*")
        .eq("bet_type", "player_prop")
        .order("created_at", {
          ascending: false
        })
        .limit(100);

    if (error) throw error;

    res.json({
      success: true,
      props_count: data?.length || 0,
      props: data || [],
      time: nowISO()
    });

  } catch (error) {

    console.error(
      "DEBUG PROPS ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
