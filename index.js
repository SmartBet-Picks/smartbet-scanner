import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, apikey");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

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
  if (odds <= -180) return 82;
  if (odds <= -150) return 85;
  if (odds <= -130) return 88;
  if (odds <= -110) return 80;
  if (odds <= 110) return 70;
  if (odds <= 150) return 60;
  return 50;
}

function riskLabel(score) {
  if (score >= 85) return "Low Risk";
  if (score >= 75) return "Medium Risk";
  return "High Risk";
}

function buildReason(score, pick) {
  if (score >= 85) {
    return `${pick} grades as an elite moneyline pick because it falls into a stronger playable odds range with a higher SmartBet confidence score.`;
  }
  if (score >= 75) {
    return `${pick} grades as a strong moneyline pick with a balanced risk profile and solid slip-building value.`;
  }
  return `${pick} qualifies as a playable moneyline pick with moderate upside, best used in balanced or aggressive builds.`;
}

function isSameDay(eventTime) {
  if (!eventTime) return false;

  const eventDate = new Date(eventTime);
  const today = new Date();

  return (
    eventDate.getFullYear() === today.getFullYear() &&
    eventDate.getMonth() === today.getMonth() &&
    eventDate.getDate() === today.getDate()
  );
}

function sameGameDate(timeA, timeB) {
  if (!timeA || !timeB) return false;

  const a = new Date(timeA);
  const b = new Date(timeB);

  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;

  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function closeGameTime(timeA, timeB) {
  if (!timeA || !timeB) return false;

  const a = new Date(timeA).getTime();
  const b = new Date(timeB).getTime();

  if (Number.isNaN(a) || Number.isNaN(b)) return false;

  const diffHours = Math.abs(a - b) / (1000 * 60 * 60);

  return diffHours <= 12;
}

function removeDuplicateGames(picks) {
  const seenGames = new Set();

  return picks.filter(pick => {
    if (seenGames.has(pick.game)) return false;
    seenGames.add(pick.game);
    return true;
  });
}

function buildSections(picks) {
  const sorted = [...picks]
    .filter(p => p.score >= 70)
    .sort((a, b) => b.score - a.score);

  const clean = removeDuplicateGames(sorted);

  return [
    ...clean.slice(0, 1).map(p => ({ ...p, section: "Free Pick" })),
    ...clean.slice(0, 5).map(p => ({ ...p, section: "Top 5 Locks" })),
    ...clean.filter(p => p.score >= 85).slice(0, 3).map(p => ({ ...p, section: "Safe Slip" })),
    ...clean.filter(p => p.score >= 75).slice(0, 5).map(p => ({ ...p, section: "Balanced Slip" })),
    ...clean.filter(p => p.score >= 70).slice(0, 6).map(p => ({ ...p, section: "Aggressive Slip" }))
  ];
}

function makeScanId() {
  return `scan_${new Date().toISOString()}`;
}

function cleanForDatabase(pick) {
  return {
    sport: pick.sport,
    game: pick.game,
    commence_time: pick.commence_time,
    market: pick.market,
    pick: pick.pick,
    odds: pick.odds,
    confidence: pick.confidence,
    score: pick.score,
    risk: pick.risk,
    reason: pick.reason,
    book: pick.book,
    stake: pick.stake,
    profit: pick.profit,
    payout: pick.payout,
    bet_link: pick.bet_link,
    section: pick.section
  };
}

function normalizeText(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function gamesMatch(pickGame, homeTeam, awayTeam) {
  const pg = normalizeText(pickGame);
  const home = normalizeText(homeTeam);
  const away = normalizeText(awayTeam);

  return pg.includes(home) && pg.includes(away);
}

function exactGameMatch(pick, scoreGame) {
  if (!pick || !scoreGame) return false;

  const sameSport = pick.sport === scoreGame.sport;
  const sameTeams = gamesMatch(pick.game, scoreGame.home_team, scoreGame.away_team);
  const sameDate = sameGameDate(pick.commence_time, scoreGame.commence_time);
  const closeTime = closeGameTime(pick.commence_time, scoreGame.commence_time);

  return sameSport && sameTeams && sameDate && closeTime;
}

function pickContainsTeam(pickText, teamName) {
  return normalizeText(pickText).includes(normalizeText(teamName));
}

function getWinnerFromScoreGame(game) {
  if (!game || !game.completed || !Array.isArray(game.scores)) return null;

  const home = game.scores.find(s => normalizeText(s.name) === normalizeText(game.home_team));
  const away = game.scores.find(s => normalizeText(s.name) === normalizeText(game.away_team));

  if (!home || !away) return null;

  const homeScore = Number(home.score);
  const awayScore = Number(away.score);

  if (Number.isNaN(homeScore) || Number.isNaN(awayScore)) return null;

  if (homeScore > awayScore) return game.home_team;
  if (awayScore > homeScore) return game.away_team;

  return null;
}

function normalizeResultForStats(result) {
  const r = String(result || "").toLowerCase();

  if (r.includes("win")) return "Win";
  if (r.includes("loss") || r.includes("lose")) return "Loss";

  return "Pending";
}

function moneyValue(num) {
  return Number(Number(num || 0).toFixed(2));
}

app.get("/", (req, res) => {
  res.send("SmartBet scanner with exact game-date grading live");
});

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

        for (const book of game.bookmakers) {
          if (!book.markets) continue;

          for (const market of book.markets) {
            if (market.key !== "h2h") continue;

            for (const outcome of market.outcomes || []) {
              const odds = Number(outcome.price);
              if (!odds || odds < -220 || odds > 200) continue;

              const score = scorePick(odds);
              if (score < 70) continue;

              const stake = 10;
              const profit = calcProfit(odds, stake);
              const payout = +(stake + profit).toFixed(2);
              const pickName = `${outcome.name} Moneyline`;

              rawPicks.push({
                sport,
                game: gameName,
                commence_time: game.commence_time,
                market: "moneyline",
                pick: pickName,
                odds,
                confidence: score,
                score,
                risk: riskLabel(score),
                reason: buildReason(score, pickName),
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

    let usablePicks = rawPicks.filter(p => isSameDay(p.commence_time));
    const usingFallback = usablePicks.length === 0;

    if (usingFallback) usablePicks = rawPicks;

    const finalPicks = buildSections(usablePicks).map(cleanForDatabase);

    const historyRows = finalPicks.map(p => ({
      ...p,
      scan_id: scanId,
      result: "Pending",
      actual_result: null,
      graded_at: null
    }));

    if (historyRows.length > 0) {
      const { error: historyError } = await supabase
        .from("pick_history")
        .insert(historyRows);

      if (historyError) {
        return res.status(500).json({
          success: false,
          step: "insert_pick_history",
          error: historyError.message,
          sample_pick: historyRows[0]
        });
      }
    }

    const { error: deleteError } = await supabase
      .from("picks")
      .delete()
      .neq("id", 0);

    if (deleteError) {
      return res.status(500).json({
        success: false,
        step: "delete_old_live_picks",
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
        step: "insert_live_picks",
        error: insertError.message,
        sample_pick: finalPicks[0]
      });
    }

    res.json({
      success: true,
      mode: "exact_game_date_tracking",
      scan_id: scanId,
      raw_picks_found: rawPicks.length,
      same_day_picks_found: rawPicks.filter(p => isSameDay(p.commence_time)).length,
      fallback_used: usingFallback,
      inserted_live: insertedRows ? insertedRows.length : 0,
      inserted_history: historyRows.length,
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

app.get("/grade", async (req, res) => {
  try {
    const { data: pendingPicks, error: fetchError } = await supabase
      .from("pick_history")
      .select("*")
      .eq("result", "Pending")
      .eq("market", "moneyline")
      .not("commence_time", "is", null);

    if (fetchError) {
      return res.status(500).json({
        success: false,
        step: "fetch_pending_moneyline_picks",
        error: fetchError.message
      });
    }

    if (!pendingPicks || pendingPicks.length === 0) {
      return res.json({
        success: true,
        mode: "exact_game_date_grading",
        message: "No pending moneyline picks with commence_time to grade.",
        graded: 0
      });
    }

    let allScoreGames = [];

    for (const sport of SPORTS) {
      const scoreUrl =
        `https://api.the-odds-api.com/v4/sports/${sport}/scores/` +
        `?apiKey=${ODDS_API_KEY}` +
        `&daysFrom=3`;

      const scoreResponse = await fetch(scoreUrl);
      const scoreData = await scoreResponse.json();

      if (Array.isArray(scoreData)) {
        allScoreGames.push(...scoreData.map(g => ({ ...g, sport })));
      }
    }

    let graded = 0;
    let wins = 0;
    let losses = 0;
    let skipped = 0;
    let unmatched = 0;
    let matchedButNotComplete = 0;
    let noWinnerFound = 0;
    let updateErrors = [];
    let debugMatchedSamples = [];
    let pendingFutureGames = 0;

    for (const pick of pendingPicks) {
      const matchedGame = allScoreGames.find(g => exactGameMatch(pick, g));

      if (!matchedGame) {
        skipped++;
        unmatched++;
        continue;
      }

      if (!matchedGame.completed) {
        skipped++;
        matchedButNotComplete++;
        pendingFutureGames++;
        continue;
      }

      const winningTeam = getWinnerFromScoreGame(matchedGame);

      debugMatchedSamples.push({
        pick_id: pick.id,
        pick: pick.pick,
        pick_game: pick.game,
        pick_commence_time: pick.commence_time,
        matched_home: matchedGame.home_team,
        matched_away: matchedGame.away_team,
        matched_commence_time: matchedGame.commence_time,
        completed: matchedGame.completed,
        scores: matchedGame.scores,
        winning_team: winningTeam
      });

      if (!winningTeam) {
        skipped++;
        noWinnerFound++;
        continue;
      }

      const result = pickContainsTeam(pick.pick, winningTeam) ? "Win" : "Loss";

      const { data: updatedRows, error: updateError } = await supabase
        .from("pick_history")
        .update({
          result,
          actual_result: `${winningTeam} won`,
          graded_at: new Date().toISOString()
        })
        .eq("id", pick.id)
        .eq("result", "Pending")
        .select();

      if (updateError) {
        skipped++;
        updateErrors.push({
          pick_id: pick.id,
          pick: pick.pick,
          error: updateError.message
        });
        continue;
      }

      if (!updatedRows || updatedRows.length === 0) {
        skipped++;
        updateErrors.push({
          pick_id: pick.id,
          pick: pick.pick,
          error: "No rows updated"
        });
        continue;
      }

      graded++;
      if (result === "Win") wins++;
      if (result === "Loss") losses++;
    }

    res.json({
      success: true,
      mode: "exact_game_date_grading",
      pending_checked: pendingPicks.length,
      score_games_found: allScoreGames.length,
      graded,
      wins,
      losses,
      skipped,
      unmatched,
      matched_but_not_complete: matchedButNotComplete,
      pending_future_games: pendingFutureGames,
      no_winner_found: noWinnerFound,
      update_errors: updateErrors.slice(0, 10),
      debug_matched_samples: debugMatchedSamples.slice(0, 5),
      note: "Only completed moneyline games are graded when sport, teams, game date, and game time match."
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      step: "exact_grade_error",
      error: err.message
    });
  }
});

app.get("/results-summary", async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from("pick_history")
      .select("*")
      .in("result", ["Win", "Loss"]);

    if (error) {
      return res.status(500).json({
        success: false,
        step: "results_summary_fetch",
        error: error.message
      });
    }

    const graded = Array.isArray(rows) ? rows : [];

    const wins = graded.filter(r => normalizeResultForStats(r.result) === "Win").length;
    const losses = graded.filter(r => normalizeResultForStats(r.result) === "Loss").length;
    const totalGraded = wins + losses;

    const totalStake = graded.reduce((sum, r) => {
      return sum + Number(r.stake || 10);
    }, 0);

    const profit = graded.reduce((sum, r) => {
      const result = normalizeResultForStats(r.result);

      if (result === "Win") {
        return sum + Number(r.profit || 0);
      }

      if (result === "Loss") {
        return sum - Number(r.stake || 10);
      }

      return sum;
    }, 0);

    const winRate = totalGraded
      ? Number(((wins / totalGraded) * 100).toFixed(1))
      : 0;

    const roi = totalStake
      ? Number(((profit / totalStake) * 100).toFixed(1))
      : 0;

    res.json({
      success: true,
      totalGraded,
      wins,
      losses,
      winRate,
      profit: moneyValue(profit),
      roi,
      totalStake: moneyValue(totalStake),
      lastUpdated: new Date().toISOString()
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      step: "results_summary_error",
      error: err.message
    });
  }
});

app.get("/debug-scores", async (req, res) => {
  try {
    let allScoreGames = [];

    for (const sport of SPORTS) {
      const scoreUrl =
        `https://api.the-odds-api.com/v4/sports/${sport}/scores/` +
        `?apiKey=${ODDS_API_KEY}` +
        `&daysFrom=3`;

      const scoreResponse = await fetch(scoreUrl);
      const scoreData = await scoreResponse.json();

      if (Array.isArray(scoreData)) {
        allScoreGames.push(...scoreData.map(g => ({ ...g, sport })));
      }
    }

    res.json({
      success: true,
      mode: "debug_all_scores",
      games_found: allScoreGames.length,
      games: allScoreGames.map(g => ({
        sport: g.sport,
        home_team: g.home_team,
        away_team: g.away_team,
        commence_time: g.commence_time,
        completed: g.completed,
        scores: g.scores
      }))
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.get("/debug-pending", async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from("pick_history")
      .select("id,sport,pick,game,commence_time,result,actual_result,graded_at,inserted_at")
      .eq("result", "Pending")
      .order("inserted_at", { ascending: false })
      .limit(50);

    if (error) {
      return res.status(500).json({
        success: false,
        step: "debug_pending_fetch",
        error: error.message
      });
    }

    res.json({
      success: true,
      pending_found: rows ? rows.length : 0,
      rows
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`SmartBet scanner with exact game-date grading running on port ${PORT}`);
});
