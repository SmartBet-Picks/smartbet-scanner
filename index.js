require("dotenv").config();

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

if (!ODDS_API_KEY) console.warn("Missing ODDS_API_KEY");
if (!SUPABASE_URL) console.warn("Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) console.warn("Missing SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const BOOKMAKER_KEY = "draftkings";
const REGIONS = "us";
const MARKETS = "h2h";
const ODDS_FORMAT = "american";

const SPORTS = [
  { key: "baseball_mlb", label: "MLB" },
  { key: "basketball_nba", label: "NBA" },
  { key: "americanfootball_nfl", label: "NFL" },
  { key: "mma_mixed_martial_arts", label: "UFC" }
];

const SECTIONS = ["Top 5 Locks", "Safe Slip", "Balanced Slip", "Aggressive Slip", "Free Pick"];

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

function calculateEdge(impliedProbability, confidence) {
  if (impliedProbability == null || confidence == null) return null;
  const modelProbability = Number(confidence) / 100;
  return Number(((modelProbability - impliedProbability) * 100).toFixed(2));
}

function getRiskLabel(confidence, odds) {
  if (confidence >= 78 && odds <= 120) return "Low";
  if (confidence >= 68) return "Medium";
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

function getTrapWarning({ odds, impliedProbability, confidence, edge }) {
  if (odds < -220 && confidence < 72) return "Heavy favorite risk";
  if (edge != null && edge < -4) return "Negative edge warning";
  if (odds > 170 && confidence < 70) return "Longshot volatility";
  if (impliedProbability && impliedProbability > 0.7 && confidence < 75) return "Public favorite caution";
  return "None";
}

function confidenceEngineV2({ odds, homeTeam, awayTeam, teamName }) {
  const implied = americanToImpliedProbability(odds);
  let confidence = 60;

  if (implied != null) {
    confidence += Math.min(18, implied * 20);
  }

  if (odds < 0) confidence += 5;
  if (odds <= -160) confidence += 3;
  if (odds >= 120) confidence -= 3;
  if (odds >= 180) confidence -= 6;

  const isHome = normalizeTeam(teamName) === normalizeTeam(homeTeam);
  if (isHome) confidence += 3;

  confidence = Math.max(45, Math.min(92, confidence));
  return Number(confidence.toFixed(1));
}

function assignSections(picks) {
  const sorted = [...picks].sort((a, b) => {
    const c = Number(b.confidence || 0) - Number(a.confidence || 0);
    if (c !== 0) return c;
    return Number(b.edge || 0) - Number(a.edge || 0);
  });

  return sorted.map((pick, index) => {
    let section = "Aggressive Slip";

    if (index < 5) section = "Top 5 Locks";
    else if (pick.confidence >= 76 && pick.volatility === "Low") section = "Safe Slip";
    else if (pick.confidence >= 68) section = "Balanced Slip";

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

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status}: ${text}`);
  }

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
        const commenceTime = game.commence_time;
        const gameDate = toDateOnly(commenceTime);
        const bookmaker = (game.bookmakers || []).find(b => b.key === BOOKMAKER_KEY);
        if (!bookmaker) continue;

        const market = (bookmaker.markets || []).find(m => m.key === MARKETS);
        if (!market || !market.outcomes) continue;

        for (const outcome of market.outcomes) {
          const teamName = outcome.name;
          const odds = Number(outcome.price);
          if (!teamName || !Number.isFinite(odds)) continue;

          const impliedProbability = americanToImpliedProbability(odds);
          const confidence = confidenceEngineV2({
            odds,
            homeTeam: game.home_team,
            awayTeam: game.away_team,
            teamName
          });

          const edge = calculateEdge(impliedProbability, confidence);
          const marketConfidence = getMarketConfidence(impliedProbability, odds);
          const volatility = getVolatility(odds, impliedProbability);
          const trapWarning = getTrapWarning({
            odds,
            impliedProbability,
            confidence,
            edge
          });

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
              impliedProbability == null ? null : Number((impliedProbability * 100).toFixed(2)),
            confidence,
            edge,
            risk: getRiskLabel(confidence, odds),
            market_confidence: marketConfidence,
            volatility,
            trap_warning: trapWarning,
            commence_time: commenceTime,
            game_date: gameDate,
            status: "Pending",
            result: "Pending",
            actual_result: null,
            graded_at: null,
            created_at: nowISO(),
            updated_at: nowISO()
          };

          allPicks.push(pick);
        }
      }
    }

    const uniquePicks = uniqueByGameAndTeam(allPicks);
    const finalPicks = assignSections(uniquePicks)
      .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
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
      message: "Scan complete",
      bookmaker: "DraftKings",
      market: "Moneyline",
      total_saved: finalPicks.length,
      top_5_count: finalPicks.filter(p => p.section === "Top 5 Locks").length,
      free_pick_count: finalPicks.filter(p => p.section === "Free Pick").length,
      time: nowISO(),
      picks: finalPicks
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
        const scoreDate = toDateOnly(game.commence_time);
        const sameDate = scoreDate === pickDate;
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

      const teamScore = scoresArr.find(s => normalizeTeam(s.name) === normalizeTeam(pick.team_name));
      const opponentScore = scoresArr.find(s => normalizeTeam(s.name) !== normalizeTeam(pick.team_name));

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
      .limit(300);

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

    const wins = unique.filter(p => p.result === "Win").length;
    const losses = unique.filter(p => p.result === "Loss").length;
    const total = wins + losses;
    const winRate = total ? Number(((wins / total) * 100).toFixed(1)) : 0;

    res.json({
      success: true,
      total,
      wins,
      losses,
      win_rate: winRate,
      recent_results: unique.slice(0, 25),
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
        sectionAnalytics[section] = { section, wins: 0, losses: 0, total: 0, win_rate: 0 };
      }

      if (!sportAnalytics[sport]) {
        sportAnalytics[sport] = { sport, wins: 0, losses: 0, total: 0, win_rate: 0 };
      }

      if (p.result === "Win") {
        sectionAnalytics[section].wins++;
        sportAnalytics[sport].wins++;
      }

      if (p.result === "Loss") {
        sectionAnalytics[section].losses++;
        sportAnalytics[sport].losses++;
      }

      sectionAnalytics[section].total++;
      sportAnalytics[sport].total++;
    }

    for (const key of Object.keys(sectionAnalytics)) {
      const x = sectionAnalytics[key];
      x.win_rate = x.total ? Number(((x.wins / x.total) * 100).toFixed(1)) : 0;
    }

    for (const key of Object.keys(sportAnalytics)) {
      const x = sportAnalytics[key];
      x.win_rate = x.total ? Number(((x.wins / x.total) * 100).toFixed(1)) : 0;
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
          recent_picks: []
        };
      }

      if (p.result === "Win") teamMap[team].wins++;
      if (p.result === "Loss") teamMap[team].losses++;

      teamMap[team].total++;
      teamMap[team].recent_picks.push({
        game: p.game,
        result: p.result,
        graded_at: p.graded_at,
        confidence: p.confidence,
        edge: p.edge
      });
    }

    const teams = Object.values(teamMap).map(t => ({
      ...t,
      win_rate: t.total ? Number(((t.wins / t.total) * 100).toFixed(1)) : 0
    }));

    const hottestTeams = teams
      .filter(t => t.total >= 2)
      .sort((a, b) => b.win_rate - a.win_rate || b.wins - a.wins)
      .slice(0, 10);

    const coldFadeTeams = teams
      .filter(t => t.total >= 2)
      .sort((a, b) => a.win_rate - b.win_rate || b.losses - a.losses)
      .slice(0, 10);

    const sharpestRecentPicks = (data || [])
      .filter(p => p.result === "Win")
      .sort((a, b) => Number(b.edge || 0) - Number(a.edge || 0))
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
