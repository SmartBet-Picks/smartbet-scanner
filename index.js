import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
const PORT = process.env.PORT || 3000;

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REGION = process.env.REGION || "us";
const BOOKMAKER = process.env.BOOKMAKER || "draftkings";
const BET_LINK = "https://sportsbook.draftkings.com/";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  db: { schema: "public" }
});

const SPORTS = [
  "basketball_nba",
  "baseball_mlb",
  "americanfootball_nfl",
  "mma_mixed_martial_arts"
];

function calcProfit(odds, stake = 10) {
  if (odds > 0) return +(stake * (odds / 100)).toFixed(2);
  return +(stake * (100 / Math.abs(odds))).toFixed(2);
}

function scorePick(odds) {
  let score = 60;

  if (odds <= -180) score = 82;
  else if (odds <= -150) score = 85;
  else if (odds <= -130) score = 88;
  else if (odds <= -110) score = 80;
  else if (odds <= 110) score = 70;
  else if (odds <= 150) score = 60;
  else score = 50;

  return score;
}

function riskLabel(score) {
  if (score >= 85) return "Low Risk";
  if (score >= 75) return "Medium Risk";
  return "High Risk";
}

function buildReason(score, odds, pick) {
  if (score >= 85) return `${pick} grades as an elite play with strong odds positioning and high confidence.`;
  if (score >= 75) return `${pick} offers strong value with balanced risk and solid win probability.`;
  if (score >= 70) return `${pick} is a playable option with moderate upside.`;
  return `${pick} did not meet elite SmartBet criteria.`;
}

function removeDuplicateGames(picks) {
  const seen = new Set();
  return picks.filter(p => {
    if (seen.has(p.game)) return false;
    seen.add(p.game);
    return true;
  });
}

function buildSections(picks) {
  const sorted = removeDuplicateGames(
    picks
      .filter(p => p.score >= 70)
      .sort((a, b) => b.score - a.score)
  );

  return [
    ...sorted.slice(0, 1).map(p => ({ ...p, section: "Free Pick" })),
    ...sorted.slice(0, 5).map(p => ({ ...p, section: "Top 5 Locks" })),
    ...sorted.filter(p => p.score >= 85).slice(0, 3).map(p => ({ ...p, section: "Safe Slip" })),
    ...sorted.filter(p => p.score >= 75).slice(0, 5).map(p => ({ ...p, section: "Balanced Slip" })),
    ...sorted.filter(p => p.score >= 70).slice(0, 6).map(p => ({ ...p, section: "Aggressive Slip" }))
  ];
}

function isSameDay(eventTime) {
  const eventDate = new Date(eventTime);
  const today = new Date();

  return (
    eventDate.getFullYear() === today.getFullYear() &&
    eventDate.getMonth() === today.getMonth() &&
    eventDate.getDate() === today.getDate()
  );
}

function makeScanId() {
  return `scan_${new Date().toISOString()}`;
}

app.get("/scan", async (req, res) => {
  try {
    const scanId = makeScanId();
    let rawPicks = [];

    for (const sport of SPORTS) {
      const url =
        `https://api.the-odds-api.com/v4/sports/${sport}/odds/` +
        `?apiKey=${ODDS_API_KEY}` +
        `&regions=${REGION}` +
        `&bookmakers=${BOOKMAKER}` +
        `&markets=h2h` +
        `&oddsFormat=american`;

      const response = await fetch(url);
      const data = await response.json();

      if (!Array.isArray(data)) continue;

      for (const game of data) {
        if (!game.bookmakers) continue;

        const gameName = `${game.away_team} @ ${game.home_team}`;
        const commenceTime = game.commence_time;

        for (const book of game.bookmakers) {
          for (const market of book.markets || []) {
            if (market.key !== "h2h") continue;

            for (const outcome of market.outcomes || []) {
              const odds = Number(outcome.price);

              if (!odds || odds < -220 || odds > 200) continue;

              const score = scorePick(odds);
              if (score < 70) continue;

              rawPicks.push({
                sport,
                game: gameName,
                commence_time: commenceTime,
                pick: `${outcome.name} Moneyline`,
                odds,
                confidence: score,
                score,
                risk: riskLabel(score),
                reason: buildReason(score, odds, outcome.name),
                stake: 10,
                profit: calcProfit(odds),
                payout: calcProfit(odds) + 10,
                bet_link: BET_LINK
              });
            }
          }
        }
      }
    }

    // 🎯 FILTER TODAY PICKS
    let todayPicks = rawPicks.filter(p => isSameDay(p.commence_time));

    // 🔄 FALLBACK IF NONE TODAY
    if (todayPicks.length === 0) {
      todayPicks = rawPicks;
    }

    const finalPicks = buildSections(todayPicks);

    // SAVE HISTORY
    const historyRows = finalPicks.map(p => ({
      ...p,
      scan_id: scanId,
      result: "Pending"
    }));

    await supabase.from("pick_history").insert(historyRows);

    // REFRESH LIVE PICKS
    await supabase.from("picks").delete().neq("id", 0);

    const { data: inserted } = await supabase
      .from("picks")
      .insert(finalPicks)
      .select();

    res.json({
      success: true,
      mode: "elite_tracking_same_day",
      scan_id: scanId,
      raw_picks_found: rawPicks.length,
      today_picks: todayPicks.length,
      inserted_live: inserted.length,
      inserted_history: historyRows.length
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log("SmartBet Elite Scanner v2 running");
});
