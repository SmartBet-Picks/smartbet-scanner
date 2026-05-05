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

function buildReason(score, odds, pick, market) {
  if (score >= 85) {
    return `${pick} grades as an elite ${market} pick because it falls into a stronger playable odds range with a higher SmartBet confidence score.`;
  }

  if (score >= 75) {
    return `${pick} grades as a strong ${market} pick with a balanced risk profile and solid slip-building value.`;
  }

  if (score >= 70) {
    return `${pick} qualifies as a playable ${market} pick with moderate upside, best used in balanced or aggressive builds.`;
  }

  return `${pick} did not grade high enough for premium SmartBet placement.`;
}

function removeDuplicateGames(picks) {
  const seenGames = new Set();
  const clean = [];

  for (const pick of picks) {
    if (seenGames.has(pick.game)) continue;
    seenGames.add(pick.game);
    clean.push(pick);
  }

  return clean;
}

function buildSections(picks) {
  const sorted = [...picks]
    .filter(p => p.score >= 70)
    .sort((a, b) => b.score - a.score);

  const noDuplicateGames = removeDuplicateGames(sorted);

  const freePick = noDuplicateGames.slice(0, 1).map(p => ({
    ...p,
    section: "Free Pick"
  }));

  const top5 = noDuplicateGames.slice(0, 5).map(p => ({
    ...p,
    section: "Top 5 Locks"
  }));

  const safeSlip = noDuplicateGames
    .filter(p => p.score >= 85)
    .slice(0, 3)
    .map(p => ({ ...p, section: "Safe Slip" }));

  const balancedSlip = noDuplicateGames
    .filter(p => p.score >= 75)
    .slice(0, 5)
    .map(p => ({ ...p, section: "Balanced Slip" }));

  const aggressiveSlip = noDuplicateGames
    .filter(p => p.score >= 70)
    .slice(0, 6)
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
  res.send("SmartBet elite scanner live");
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

              // Elite filter: removes extreme favorite traps and weak longshots
              if (!odds || odds < -220 || odds > 200) continue;

              const score = scorePick(odds);

              // Elite filter: only keep strong SmartBet grades
              if (score < 70) continue;

              const risk = riskLabel(score);
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

    if (finalPicks.length === 0) {
      return res.json({
        success: true,
        message: "Scanner ran successfully, but no elite picks passed the filters.",
        raw_picks_found: rawPicks.length,
        inserted: 0
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
      mode: "elite",
      raw_picks_found: rawPicks.length,
      inserted: insertedRows.length,
      sections: {
        free_pick: finalPicks.filter(p => p.section === "Free Pick").length,
        top_5_locks: finalPicks.filter(p => p.section === "Top 5 Locks").length,
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
  console.log(`SmartBet elite scanner running on port ${PORT}`);
});
