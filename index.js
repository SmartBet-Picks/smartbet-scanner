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
  let score = 55;

  if (odds <= -200) score = 72;
  else if (odds <= -170) score = 76;
  else if (odds <= -140) score = 80;
  else if (odds <= -110) score = 74;
  else if (odds >= -105 && odds <= 120) score = 66;
  else if (odds > 120 && odds <= 180) score = 58;
  else if (odds > 180) score = 50;

  return score;
}

function riskLabel(score, odds) {
  if (score >= 76 && odds <= 140) return "Lower Risk";
  if (score >= 66) return "Medium Risk";
  return "Higher Risk";
}

function buildReason(score, odds, pick, market) {
  if (score >= 76) {
    return `${pick} grades as a top-rated ${market} pick because the odds are in a stronger playable range with lower volatility.`;
  }

  if (score >= 66) {
    return `${pick} has a balanced profile with reasonable odds and useful upside for slip building.`;
  }

  return `${pick} is a higher-risk option with more payout upside, better suited for aggressive slips.`;
}

function buildSections(picks) {
  const sorted = [...picks].sort((a, b) => b.score - a.score);

  const freePick = sorted.slice(0, 1).map(p => ({
    ...p,
    section: "Free Pick"
  }));

  const top5 = sorted.slice(0, 5).map(p => ({
    ...p,
    section: "Top 5 Locks"
  }));

  const safeSlip = sorted
    .filter(p => p.score >= 76)
    .slice(0, 3)
    .map(p => ({ ...p, section: "Safe Slip" }));

  const balancedSlip = sorted
    .filter(p => p.score >= 66)
    .slice(0, 5)
    .map(p => ({ ...p, section: "Balanced Slip" }));

  const aggressiveSlip = sorted
    .filter(p => p.score >= 50)
    .slice(0, 7)
    .map(p => ({ ...p, section: "Aggressive Slip" }));

  return [
    ...freePick,
    ...top5,
    ...safeSlip,
    ...balancedSlip,
    ...aggressiveSlip
  ];
}

app.get("/", (req, res) => {
  res.send("SmartBet scanner live");
});

app.get("/scan", async (req, res) => {
  try {
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

        for (const book of game.bookmakers) {
          if (!book.markets) continue;

          for (const market of book.markets) {
            if (market.key !== "h2h") continue;

            for (const outcome of market.outcomes || []) {
              const odds = Number(outcome.price);
              if (!odds || odds < -250 || odds > 250) continue;

              const score = scorePick(odds);
              const risk = riskLabel(score, odds);
              const stake = 10;
              const profit = calcProfit(odds, stake);
              const payout = +(stake + profit).toFixed(2);
              const pickName = `${outcome.name} Moneyline`;

              rawPicks.push({
                sport,
                game: gameName,
                market: "moneyline",
                pick: pickName,
                odds,
                confidence: score,
                score,
                risk,
                reason: buildReason(score, odds, pickName, "moneyline"),
                book: book.key || BOOKMAKER,
                stake,
                profit,
                payout,
                bet_link: BET_LINK
              });
            }
          }
        }
      }
    }

    const finalPicks = buildSections(rawPicks);

    const { error: deleteError } = await supabase
      .from("picks")
      .delete()
      .neq("id", 0);

    if (deleteError) {
      return res.status(500).json({
        success: false,
        step: "delete_old_picks",
        error: deleteError.message
      });
    }

    const { data: insertedRows, error: insertError } = await supabase
      .from("picks")
      .insert(finalPicks)
      .select();

    if (insertError) {
      return res.status(500).json({
        success: false,
        step: "insert_picks",
        error: insertError.message,
        sample_pick: finalPicks[0]
      });
    }

    res.json({
      success: true,
      raw_picks_found: rawPicks.length,
      inserted: insertedRows.length,
      sections: {
        free_pick: 1,
        top_5_locks: 5,
        safe_slip: finalPicks.filter(p => p.section === "Safe Slip").length,
        balanced_slip: finalPicks.filter(p => p.section === "Balanced Slip").length,
        aggressive_slip: finalPicks.filter(p => p.section === "Aggressive Slip").length
      }
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      step: "main_error",
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`SmartBet scanner running on port ${PORT}`);
});
