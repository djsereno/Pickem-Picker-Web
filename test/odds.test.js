import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import getOddsData, { rankGame } from '../odds.js';
import { buildSchedule, buildForecasts } from '../survivor.js';

const fixture = JSON.parse(readFileSync(new URL('../sample-data.json', import.meta.url), 'utf8'));

// One game, two bookmakers: a sharp book (-6.5 home, moneyline favouring home) and a soft
// one (-5.5), so the tests also pin how the quality weighting blends them.
const bookMaker = (key, point, homePrice, awayPrice, total) => ({
  key,
  markets: [
    { key: 'spreads', outcomes: [{ name: 'Kansas City Chiefs', point }, { name: 'Denver Broncos', point: -point }] },
    { key: 'totals', outcomes: [{ name: 'Over', point: total }, { name: 'Under', point: total }] },
    { key: 'h2h', outcomes: [{ name: 'Kansas City Chiefs', price: homePrice }, { name: 'Denver Broncos', price: awayPrice }] },
  ],
});
const game = (overrides = {}) => ({
  commence_time: '2026-09-11T00:15:00Z',
  home_team: 'Kansas City Chiefs',
  away_team: 'Denver Broncos',
  bookmakers: [bookMaker('draftkings', -6.5, 1.36, 3.2, 47), bookMaker('betus', -5.5, 1.4, 3.0, 45)],
  ...overrides,
});

test('rankGame reads spread, total and de-vigged moneyline from the books', () => {
  const ranking = rankGame(game());
  assert.equal(ranking.home, 'Kansas City Chiefs');
  assert.equal(ranking.away, 'Denver Broncos');
  assert.equal(ranking.favorite, 'Kansas City Chiefs'); // negative home spread = home favoured
  // Sharp book counts double: (-6.5*2 + -5.5*0.5)/2.5 = -6.3
  assert.equal(Math.abs(ranking.aveSpread - -6.3) < 1e-9, true, `aveSpread ${ranking.aveSpread}`);
  // (47*2 + 45*0.5)/2.5 = 46.6
  assert.equal(Math.abs(ranking.aveTotal - 46.6) < 1e-9, true, `aveTotal ${ranking.aveTotal}`);
  // De-vigged from the sharp book: (1/1.36)/((1/1.36)+(1/3.2)) = 0.7017 -> that favourite
  // probability blended in, and the model agrees the home side is strong.
  assert.equal(ranking.marketProb > 0.6, true, `marketProb ${ranking.marketProb}`);
  assert.equal(ranking.winProbability > 0.6, true, `winProbability ${ranking.winProbability}`);
  assert.equal(ranking.key, 'Denver Broncos|Kansas City Chiefs|2026-09-11T00:15:00Z');
});

test('rankGame flips the favourite when the away side is favoured', () => {
  const awayFavoured = game({
    bookmakers: [bookMaker('draftkings', 7, 3.4, 1.32, 44)], // positive home spread = road favourite
  });
  const ranking = rankGame(awayFavoured);
  assert.equal(ranking.favorite, 'Denver Broncos');
  assert.equal(ranking.aveSpread, 7);
});

test('rankGame falls back to the model when no moneyline is posted, and skips unrankable games', () => {
  const noMoneyline = game({
    bookmakers: [{ key: 'draftkings', markets: [{ key: 'spreads', outcomes: [{ name: 'Kansas City Chiefs', point: -3 }, { name: 'Denver Broncos', point: 3 }] }] }],
  });
  const ranking = rankGame(noMoneyline);
  assert.equal(ranking.marketProb, null);
  assert.equal(ranking.winProbability, ranking.modelProb);
  assert.equal(ranking.aveTotal, 44); // BASELINE_TOTAL when no book posts a total
  // No spreads at all -> nothing to rank (the old code produced a NaN row instead).
  assert.equal(rankGame(game({ bookmakers: [] })), null);
  assert.equal(rankGame(game({ bookmakers: [{ key: 'draftkings', markets: [{ key: 'h2h', outcomes: [] }] }] })), null);
});

// ── Whole-season ranking (per week), via the dataOverride seam ───────────────────

test('the fixture is ranked end to end, while the current week stays its own list', async () => {
  const odds = await getOddsData(null, fixture);
  assert.equal(odds.allRankings.length, fixture.length); // every game carries odds
  // The main table's list is still only the current Tue-Tue window.
  assert.equal(odds.sortedRankings.length, odds.currentWeeksGames.length);
  assert.equal(odds.sortedRankings.length < odds.allRankings.length, true);
  const windowKeys = new Set(odds.currentWeeksGames.map((game) => `${game.away_team}|${game.home_team}|${game.commence_time}`));
  assert.equal(odds.sortedRankings.every((game) => windowKeys.has(game.key)), true);
  // Sorted by win probability, best first.
  for (let i = 1; i < odds.sortedRankings.length; i += 1) {
    assert.equal(odds.sortedRankings[i - 1].winProbability >= odds.sortedRankings[i].winProbability, true);
  }
});

test('the tiebreaker stays on the last game of the current week', async () => {
  const odds = await getOddsData(null, fixture);
  const lastKickoff = Math.max(...odds.currentWeeksGames.map((game) => new Date(game.commence_time).getTime()));
  assert.equal(odds.tiebreaker.commence.getTime(), lastKickoff);
  // Ranking the entire season must not drag it out to the season finale.
  const seasonEnd = Math.max(...fixture.map((game) => new Date(game.commence_time).getTime()));
  assert.equal(odds.tiebreaker.commence.getTime() < seasonEnd, true);
  assert.equal(typeof odds.tiebreaker.aveTotal === 'number' && odds.tiebreaker.aveTotal > 0, true);
});

test('every week of the season gets real market probabilities, not Elo guesses', async () => {
  const odds = await getOddsData(null, fixture);
  const schedule = buildSchedule(fixture);
  const byKickoff = new Map(odds.allRankings.map((game) => [new Date(game.commence).getTime(), game]));
  const weeks = new Map();
  for (const game of schedule) {
    const ranked = byKickoff.get(new Date(game.kickoff).getTime());
    if (!ranked) continue;
    const bucket = weeks.get(game.week) || { ranked: 0, withMarket: 0 };
    bucket.ranked += 1;
    if (ranked.marketProb != null) bucket.withMarket += 1;
    weeks.set(game.week, bucket);
  }
  assert.equal(weeks.size, 18);
  for (const [week, bucket] of weeks) {
    assert.equal(bucket.ranked >= 13, true, `week ${week} ranked ${bucket.ranked}`);
    assert.equal(bucket.withMarket, bucket.ranked, `week ${week} missing moneylines`);
  }
  // And the strategy engine consumes them: no game falls back to Elo any more.
  const forecasts = buildForecasts(schedule, odds.allRankings, (g) => (g.marketProb == null ? g.modelProb : 0.5 * g.modelProb + 0.5 * g.marketProb));
  assert.equal(forecasts.every((game) => game.source === 'Market blend'), true);
  // Future weeks now carry differentiated numbers instead of an identical Elo 57.8%.
  const week12 = forecasts.filter((game) => game.week === 12).flatMap((game) => [game.homeProbability, game.awayProbability]);
  assert.equal(Math.max(...week12) - Math.min(...week12) > 0.2, true, 'week 12 probabilities should span a real range');
});
