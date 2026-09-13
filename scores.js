// Game results from the Odds API's scores endpoint (GET /v4/sports/{sport}/scores).
// The endpoint returns live and recently completed games; `daysFrom` reaches up to 3
// days into the past (2 usage credits per call, 1 without the parameter). That short
// window is why every completed result we observe is persisted in localStorage under
// RESULTS_STORAGE_KEY — results older than 3 days can never be re-fetched, so the
// store (not the API) is the season-long source of truth once a game is captured.
//
// Everything here is pure except fetchScores/saveResults, mirroring how survivor.js
// keeps its helpers testable under `node --test`.

import { teamId } from './survivor.js';

export const SPORT_KEY = 'americanfootball_nfl';
export const RESULTS_STORAGE_KEY = 'pickem-game-results-v1';
export const SCORES_THROTTLE_MS = 6 * 60 * 60 * 1000; // auto-fetch at most every 6 hours

// daysFrom is capped at 3 by the API; a Thu->Mon NFL week always fits inside it as
// long as the page is loaded (or Update scores clicked) within 3 days of the week's end.
export const fetchScores = async (apiKey, daysFrom = 3) => {
  if (!apiKey) return null;
  const url = `https://api.the-odds-api.com/v4/sports/${SPORT_KEY}/scores/?apiKey=${encodeURIComponent(apiKey)}&daysFrom=${daysFrom}&dateFormat=iso`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Scores request failed: ${response.status} ${response.statusText}`);
      return null;
    }
    const events = await response.json();
    return Array.isArray(events) ? events : null;
  } catch (error) {
    console.error('Scores request failed:', error);
    return null;
  }
};

// The API reports scores as strings ("27"); normalize, treating anything non-numeric
// as "no score reported" so glitched payloads never fabricate a winner.
const numericScore = (value) => {
  const parsed = Number(value);
  return value == null || value === '' || !Number.isFinite(parsed) ? null : parsed;
};

export const resultKey = (away, home) => `${teamId(away)}|${teamId(home)}`;
// One API event -> one stored entry. `winner`/keys use the app's short team names,
// the same `away|home` key space shared by the schedule, odds rows and sim harness.
// In-progress games carry scores but NEVER a winner — only completed games may
// advance completedWeek()/locking/eliminations.
export const scoreEventEntry = (event) => {
  const entry = {
    status: event.completed ? 'final' : 'scheduled',
    tied: false,
    winner: null,
    awayScore: null,
    homeScore: null,
    kickoff: event.commence_time || null,
    lastUpdate: event.last_update || null,
  };
  const awayName = teamId(event.away_team);
  const homeName = teamId(event.home_team);
  const sides = (event.scores || [])
    .map((side) => ({ name: teamId(side.name), score: numericScore(side.score) }))
    .filter((side) => side.name && side.score != null);
  const away = sides.find((side) => side.name === awayName);
  const home = sides.find((side) => side.name === homeName);
  if (away) entry.awayScore = away.score;
  if (home) entry.homeScore = home.score;
  const complete = entry.awayScore != null && entry.homeScore != null;
  if (complete) {
    if (event.completed) {
      if (away.score === home.score) entry.tied = true; // ties matter: they eliminate survivor picks
      else entry.winner = away.score > home.score ? awayName : homeName;
    } else {
      entry.status = 'live';
    }
  } else if ((entry.awayScore != null || entry.homeScore != null) && !event.completed) {
    // Partial score data (one side glitched/missing): still show it as live progress,
    // but never derive an outcome from half a box score.
    entry.status = 'live';
  }
  return entry;
};

export const mapScoreEvents = (events) => {
  const mapped = new Map();
  for (const event of events || []) {
    if (!event?.away_team || !event?.home_team) continue;
    mapped.set(resultKey(event.away_team, event.home_team), scoreEventEntry(event));
  }
  return mapped;
};


export const createResults = () => ({ version: 1, games: {}, updatedAt: null, attemptedAt: null });

export const loadResults = () => {
  if (typeof localStorage === 'undefined') return createResults();
  try {
    const stored = JSON.parse(localStorage.getItem(RESULTS_STORAGE_KEY));
    if (stored && stored.version === 1 && stored.games && typeof stored.games === 'object') {
      return { ...createResults(), ...stored, games: stored.games };
    }
  } catch { /* corrupt storage -> fresh store */ }
  return createResults();
};

export const saveResults = (results) => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(RESULTS_STORAGE_KEY, JSON.stringify(results));
  } catch { /* storage full/unavailable — results stay in memory for this session */ }
};

// Fold a fresh scores response into the persistent store (fresh API data wins).
export const absorbEvents = (results, events) => {
  for (const [key, entry] of mapScoreEvents(events)) results.games[key] = entry;
  return results;
};

// Auto-fetch gate: attempts (successful or not) feed the throttle, so a failing
// network/key can't turn every page load into a credits-burning retry loop.
export const shouldAutoFetch = (results, now = Date.now(), throttleMs = SCORES_THROTTLE_MS) => {
  const attemptedAt = results?.attemptedAt;
  return !attemptedAt || now - attemptedAt > throttleMs;
};

// Fold stored/fresh results onto the schedule (mutates, returns count of outcome changes).
// Precedence: a definite API outcome (final winner/tie) overrides hand-entered fixture
// fields; live/scheduled entries only attach informational scores to games that don't
// already have an outcome. This is the single point where real results enter the app —
// completedWeek(), locking, eliminations and pill tints all read the schedule afterward.
export const mergeResults = (schedule, results) => {
  let applied = 0;
  for (const game of schedule || []) {
    const entry = results?.games?.[`${game.away}|${game.home}`];
    if (!entry) continue;
    if (entry.status === 'final' && (entry.winner || entry.tied)) {
      const nextWinner = entry.tied ? null : entry.winner;
      if (game.winner !== nextWinner || !game.tied !== !entry.tied) applied += 1;
      game.winner = nextWinner;
      game.tied = !!entry.tied;
    }
    if (!game.winner && !game.tied) {
      game.awayScore = entry.awayScore;
      game.homeScore = entry.homeScore;
      game.resultStatus = entry.status;
      game.resultUpdated = entry.lastUpdate || null;
    } else if (entry.status === 'final') {
      // Games whose outcome came from the fixture still take the API's final scores
      // and final status.
      game.resultStatus = 'final';
      if (entry.awayScore != null) game.awayScore = entry.awayScore;
      if (entry.homeScore != null) game.homeScore = entry.homeScore;
    }
  }
  return applied;
};

// Pure classifier for the week-aware board: every scheduled game becomes a row tagged
// 'final' (result known), 'live' (scores in, no winner yet) or 'open' (ranking row).
// Open rows carry the forecast's favorite-side probability so the caller can rank them;
// rows stay in kickoff order (buildSchedule pre-sorts the schedule).
export const buildWeekBoardRows = (schedule, forecasts, week) => (schedule || [])
  .filter((game) => game.week === week)
  .map((game) => {
    const forecast = (forecasts || []).find(
      (candidate) => candidate.week === week && candidate.home === game.home && candidate.away === game.away,
    );
    const homeProbability = forecast ? forecast.homeProbability : 0.5;
    const type = game.winner || game.tied ? 'final'
      : game.resultStatus === 'live' ? 'live'
      : game.resultStatus === 'final' ? 'final' // completed but no reportable scores
      : 'open';
    return {
      week,
      home: game.home,
      away: game.away,
      kickoff: game.kickoff,
      type,
      winner: game.winner || null,
      tied: !!game.tied,
      awayScore: game.awayScore ?? null,
      homeScore: game.homeScore ?? null,
      probability: Math.max(homeProbability, 1 - homeProbability),
      favorite: homeProbability >= 0.5 ? game.home : game.away,
      source: forecast ? forecast.source : 'Elo fallback',
    };
  });

