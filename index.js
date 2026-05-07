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

  return `${pick} qualifies as a playable moneyline pick with moderate upside.`;
}

function normalizeResult(result){
  const r = String(result || "").toLowerCase();

  if (r.includes("win")) return "Win";
  if (r.includes("loss")) return "Loss";

  return "Pending";
}

function moneyValue(num){
  return Number(Number(num || 0).toFixed(2));
}

app.get("/", (req, res) => {
  res.send("SmartBet Elite System Live");
});

app.get("/results-summary", async (req, res) => {

  try {

    const { data: rows, error } = await supabase
      .from("pick_history")
      .select("*")
      .in("result", ["Win", "Loss"])
      .order("graded_at", { ascending: false });

    if (error) {
      return res.status(500).json({
        success:false,
        error:error.message
      });
    }

    const graded = Array.isArray(rows) ? rows : [];

    const wins = graded.filter(r =>
      normalizeResult(r.result) === "Win"
    ).length;

    const losses = graded.filter(r =>
      normalizeResult(r.result) === "Loss"
    ).length;

    const totalGraded = wins + losses;

    const totalStake = graded.reduce((sum, r) => {
      return sum + Number(r.stake || 10);
    }, 0);

    const profit = graded.reduce((sum, r) => {

      const result = normalizeResult(r.result);

      if (result === "Win") {
        return sum + Number(r.profit || 0);
      }

      if (result === "Loss") {
        return sum - Number(r.stake || 10);
      }

      return sum;

    }, 0);

    const winRate =
      totalGraded > 0
        ? (wins / totalGraded) * 100
        : 0;

    const roi =
      totalStake > 0
        ? (profit / totalStake) * 100
        : 0;

    res.json({
      success:true,
      totalGraded,
      wins,
      losses,
      winRate:Number(winRate.toFixed(1)),
      profit:moneyValue(profit),
      roi:Number(roi.toFixed(1)),
      lastUpdated:new Date().toISOString()
    });

  } catch(err){

    res.status(500).json({
      success:false,
      error:err.message
    });

  }

});

app.listen(PORT, () => {
  console.log(`SmartBet Elite running on ${PORT}`);
});
