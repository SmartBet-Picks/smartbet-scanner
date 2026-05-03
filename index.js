const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

// ENV VARIABLES
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REGION = process.env.REGION || "us";
const BOOKMAKER = process.env.BOOKMAKER || "draftkings";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// SPORTS
const SPORTS = [
  "basketball_nba",
  "baseball_mlb",
  "americanfootball_nfl",
  "mma_mixed_martial_arts"
];

// MARKETS
const GAME_MARKETS = "h2h,spreads,totals";

const PROP_MARKETS = [
  "player_points",
  "player_rebounds",
  "player_assists",
  "player_threes",
  "player_pass_tds",
  "player_pass_yds",
  "player_rush_yds",
  "player_receptions",
  "player_receiving_yds",
  "batter_home_runs",
  "batter_hits",
  "batter_total_bases",
  "batter_rbis",
  "batter_runs_scored",
  "pitcher_strikeouts"
].join(",");

// HELPERS
function oddsInRange(odds) {
  return odds >= -250 && odds <= 250;
}

function profitFromOdds(odds, stake = 10) {
  if (odds > 0) return +(stake * (odds / 100)).toFixed(2);
  return +(stake * (100 / Math.abs(odds))).toFixed(2);
}

function cleanMarket(market) {
  const map = {
    h2h: "Moneyline",
    spreads: "Spread",
    totals: "Total",
    player_points: "Points",
    player_rebounds: "Rebounds",
    player_assists: "Assists",
    player_threes: "3-Pointers",
    player_pass_tds: "Pass TDs",
    player_pass_yds: "Pass Yards",
    player_rush_yds: "Rush Yards",
    player_receptions: "Receptions",
    player_receiving_yds: "Receiving Yards",
    batter_home_runs: "Home Runs",
    batter_hits: "Hits",
    batter_total_bases: "Total Bases",
    batter_rbis: "RBIs",
    batter_runs_scored: "Runs Scored",
    pitcher_strikeouts: "Strikeouts"
  };

  return map[market] || market.replace(/_/g, " ");
}

function scorePick(type, market, odds) {
  let score = type === "Prop" ? 50 : 55;

  if (market === "h2h") score += 12;
  if (market === "spreads") score += 8;
  if (market === "totals") score += 6;

  if (type === "Prop") score += 8;

  if (odds >= -160 && odds <= -110) score += 12;
  else if (odds >= -200 && odds < -160) score += 7;
  else if (odds >= -105 && odds <= 120) score += 8;
  else if (odds > 120 && odds <= 180) score += 4;

  return Math.min(score, 85);
}

function riskLabel(score) {
  if (score >= 72) return "Lower Risk";
  if (score >= 62) return "Medium Risk";
  return "Higher Risk";
}

function reason(type, market, score) {
  const label = cleanMarket(market);

  if (type === "Prop") {
    if (score >= 70) return `Top-rated ${label} prop with strong slip value.`;
    if (score >= 60) return `Balanced ${label} prop with solid upside.`;
    return `Higher-risk ${label} prop for aggressive slips.`;
  }

  if (score >= 70) return `Strong ${label} profile with controlled risk.`;
  if (score >= 60) return `Balanced ${label} play with upside.`;
  return `Higher-risk ${label} option.`;
}

// LOGGING
async function logScan(step, status, message) {
  await supabase.from("scan_logs").insert({
    step,
    status,
    message
  });
}

// CLEAR OLD DATA
async function clearOldPicks() {
  await supabase.from("picks").delete().neq("id", 0);
}

// FETCH HELPER
async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();

  if (!res.ok) throw new Error(text);

  return JSON.parse(text);
}

// BUILD PICKS
function buildGamePick(market, outcome) {
  const side = outcome.name || "";
  const line = outcome.point ?? "";

  if (market === "h2h") return `${side} Moneyline`;
  if (market === "spreads") return `${side} ${line}`;
  if (market === "totals") return `${side} ${line} Total`;

  return side;
}

function buildPropPick(market, outcome) {
  const player = outcome.description || outcome.name || "Player";
  const side = outcome.name || "";
  const line = outcome.point ?? "";

  return `${player} ${side} ${line} ${cleanMarket(market)}`;
}

// GAME SCANNER
async function scanGameOdds() {
  const picks = [];
  const events = [];

  for (const sport of SPORTS) {
    const url =
      `https://api.the-odds-api.com/v4/sports/${sport}/odds` +
      `?apiKey=${ODDS_API_KEY}` +
      `&regions=${REGION}` +
      `&bookmakers=${BOOKMAKER}` +
      `&markets=${GAME_MARKETS}`;

    try {
      const games = await fetchJson(url);

      for (const game of games) {
        const gameName = `${game.away_team} @ ${game.home_team}`;

        events.push({
          sport,
          event_id: game.id,
          game: gameName
        });

        for (const book of game.bookmakers || []) {
          for (const market of book.markets || []) {
            for (const outcome of market.outcomes || []) {
              const odds = Number(outcome.price);
              if (!oddsInRange(odds)) continue;

              const score = scorePick("Game", market.key, odds);
              const profit = profitFromOdds(odds);

              picks.push({
                section: "Pick Feed",
                sport,
                game: gameName,
                market: cleanMarket(market.key),
                pick: buildGamePick(market.key, outcome),
                odds,
                book: BOOKMAKER,
                score,
                risk: riskLabel(score),
                reason: reason("Game", market.key, score),
                stake: 10,
                profit,
                payout: 10 + profit,
                bet_link: "https://sportsbook.draftkings.com/"
              });
            }
          }
        }
      }
    } catch (err) {
      await logScan("game_odds", "error", err.message);
    }
  }

  return { picks, events };
}

// PROP SCANNER
async function scanProps(events) {
  const picks = [];

  for (const event of events.slice(0, 10)) {
    const url =
      `https://api.the-odds-api.com/v4/sports/${event.sport}/events/${event.event_id}/odds` +
      `?apiKey=${ODDS_API_KEY}` +
      `&regions=${REGION}` +
      `&bookmakers=${BOOKMAKER}` +
      `&markets=${PROP_MARKETS}`;

    try {
      const data = await fetchJson(url);

      for (const book of data.bookmakers || []) {
        for (const market of book.markets || []) {
          for (const outcome of market.outcomes || []) {
            const odds = Number(outcome.price);
            if (!oddsInRange(odds)) continue;

            const score = scorePick("Prop", market.key, odds);
            const profit = profitFromOdds(odds);

            picks.push({
              section: "Top Props",
              sport: event.sport,
              game: event.game,
              market: cleanMarket(market.key),
              pick: buildPropPick(market.key, outcome),
              odds,
              book: BOOKMAKER,
              score,
              risk: riskLabel(score),
              reason: reason("Prop", market.key, score),
              stake: 10,
              profit,
              payout: 10 + profit,
              bet_link: "https://sportsbook.draftkings.com/"
            });
          }
        }
      }
    } catch (err) {
      await logScan("props", "error", err.message);
    }
  }

  return picks;
}

// FINAL BUILD
function buildFinal(picks) {
  const sorted = picks.sort((a, b) => b.score - a.score);

  return [
    ...sorted.slice(0, 5).map(p => ({ ...p, section: "Top 5 Locks" })),
    ...sorted.filter(p => p.section === "Top Props").slice(0, 10),
    ...sorted.filter(p => p.score >= 72).slice(0, 3).map(p => ({ ...p, section: "Safe Slip" })),
    ...sorted.filter(p => p.score >= 62).slice(0, 5).map(p => ({ ...p, section: "Balanced Slip" })),
    ...sorted.filter(p => p.score >= 50).slice(0, 7).map(p => ({ ...p, section: "Aggressive Slip" }))
  ];
}

// RUN
async function runScanner() {
  await clearOldPicks();

  const { picks: gamePicks, events } = await scanGameOdds();
  const propPicks = await scanProps(events);

  const final = buildFinal([...gamePicks, ...propPicks]);

  if (final.length > 0) {
    await supabase.from("picks").insert(final);
  }

  return final.length;
}

// ROUTES
app.get("/", (req, res) => {
  res.send("SmartBet scanner live");
});

app.get("/scan", async (req, res) => {
  try {
    const count = await runScanner();
    res.json({ success: true, inserted: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// START SERVER
app.listen(PORT, () => {
  console.log(`Running on ${PORT}`);
});
