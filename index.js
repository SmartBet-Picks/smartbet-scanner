import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { db: { schema: "public" } }
);

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const REGION = process.env.REGION || "us";
const BOOKMAKER = process.env.BOOKMAKER || "draftkings";

app.get("/", (req, res) => {
  res.send("SmartBet scanner live");
});

app.get("/scan", async (req, res) => {
  try {
    const sports = ["basketball_nba", "baseball_mlb", "americanfootball_nfl", "mma_mixed_martial_arts"];
    let picks = [];

    for (const sport of sports) {
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_API_KEY}&regions=${REGION}&bookmakers=${BOOKMAKER}&markets=h2h&oddsFormat=american`;

      const response = await fetch(url);
      const data = await response.json();

      if (!Array.isArray(data)) continue;

      for (const game of data) {
        const gameName = `${game.away_team} @ ${game.home_team}`;

        for (const book of game.bookmakers || []) {
          for (const market of book.markets || []) {
            for (const outcome of market.outcomes || []) {
              const odds = Number(outcome.price);
              let confidence = 60;

              if (odds <= -200) confidence = 85;
              else if (odds <= -150) confidence = 75;
              else if (odds >= 150) confidence = 55;

              picks.push({
                sport,
                game: gameName,
                market: "moneyline",
                pick: outcome.name,
                odds,
                confidence,
                book: book.key || BOOKMAKER
              });
            }
          }
        }
      }
    }

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
      .insert(picks)
      .select();

    if (insertError) {
      return res.status(500).json({
        success: false,
        step: "insert_picks",
        error: insertError.message,
        sample_pick: picks[0]
      });
    }

    res.json({
      success: true,
      total_picks_found: picks.length,
      inserted: insertedRows.length
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
  console.log(`Running on port ${PORT}`);
});
