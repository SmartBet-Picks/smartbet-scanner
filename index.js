import express from 'express'
import fetch from 'node-fetch'
import { createClient } from '@supabase/supabase-js'

const app = express()

// ENV VARIABLES
const ODDS_API_KEY = process.env.ODDS_API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const REGION = process.env.REGION || 'us'
const BOOKMAKER = process.env.BOOKMAKER || 'draftkings'

// SUPABASE CLIENT
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ROOT CHECK
app.get('/', (req, res) => {
  res.send('SmartBet scanner live')
})

// MAIN SCANNER
app.get('/scan', async (req, res) => {
  try {
    const sports = [
      'basketball_nba',
      'americanfootball_nfl',
      'mma_mixed_martial_arts'
    ]

    let allPicks = []

    for (const sport of sports) {
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?regions=${REGION}&markets=h2h&apiKey=${ODDS_API_KEY}`

      const response = await fetch(url)
      const data = await response.json()

      for (const game of data) {
        if (!game.bookmakers) continue

        const book = game.bookmakers.find(b => b.key === BOOKMAKER)
        if (!book) continue

        const market = book.markets.find(m => m.key === 'h2h')
        if (!market) continue

        for (const outcome of market.outcomes) {
          const odds = outcome.price

          // SIMPLE CONFIDENCE MODEL
          let confidence = 50
          if (odds < -150) confidence = 75
          if (odds < -200) confidence = 85
          if (odds > 150) confidence = 55

          const pick = {
            sport,
            game: `${game.home_team} vs ${game.away_team}`,
            market: 'moneyline',
            pick: outcome.name,
            odds,
            confidence,
            book: BOOKMAKER
          }

          allPicks.push(pick)
        }
      }
    }

    // 🔥 CLEAR OLD PICKS (IMPORTANT)
    await supabase.from('picks').delete().neq('id', 0)

    // 🔥 INSERT PICKS INTO SUPABASE
    let inserted = 0

    for (const pick of allPicks) {
      const { error } = await supabase
        .from('picks')
        .insert([
          {
            sport: pick.sport,
            game: pick.game,
            market: pick.market,
            pick: pick.pick,
            odds: pick.odds,
            confidence: pick.confidence,
            book: pick.book,
            created_at: new Date()
          }
        ])

      if (!error) inserted++
      else console.log('Insert error:', error)
    }

    res.json({
      success: true,
      total_picks: allPicks.length,
      inserted
    })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Scanner failed' })
  }
})

// PORT
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
