// Game results from the Odds API's scores endpoint (GET /v4/sports/{sport}/scores).
// The endpoint returns live and recently completed games; `daysFrom` reaches up to 3
// days into the past (2 usage credits per call, 1 without the parameter). That short
// window is why every completed result we observe is persisted in localStorage under
// RESULTS_STORAGE_KEY — results older than 3 days can never be re-fetched, so the
// store (not the API) is the season-long source of truth once a game is captured.
//
// Everything here is pure except fetchScores/saveResults, mirroring how survivor.js
// keeps its helpers testable under `node --test`.

import { TEAM_FULL_NAMES, teamId } from './survivor.js';

export const SPORT_KEY = 'americanfootball_nfl';
export const RESULTS_STORAGE_KEY = 'pickem-game-results-v1';
export const SCORES_THROTTLE_MS = 6 * 60 * 60 * 1000; // auto-fetch at most every 6 hours

// daysFrom is capped at 3 by the API; a Thu->Mon NFL week always fits inside it as
// long as the page is loaded (or Fetch scores clicked) within 3 days of the week's end.
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

// Google lookup for a game's final score: full team names plus the kickoff date, so the
// search lands on this exact meeting instead of a same-named team from another sport.
export const googleScoreUrl = (game) => {
  const away = TEAM_FULL_NAMES[game.away] || game.away;
  const home = TEAM_FULL_NAMES[game.home] || game.home;
  const date = new Date(game.kickoff).toLocaleDateString('en-us', { month: 'short', day: 'numeric', year: 'numeric' });
  return `https://www.google.com/search?q=${encodeURIComponent(`${away} vs ${home} score ${date}`)}`;
};
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

// Fold a fresh scores response into the persistent store. Hand-entered results are
// only replaced by a definite API outcome - a live, scheduled or score-less response
// never clobbers what the user typed in.
export const absorbEvents = (results, events) => {
  for (const [key, entry] of mapScoreEvents(events)) {
    const stored = results.games[key];
    const definite = entry.status === 'final' && (entry.winner || entry.tied);
    if (stored?.manual && !definite) continue;
    results.games[key] = entry;
  }
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

// Grades the model's pre-game pick against a decided outcome for the board's result
// rows: 'correct' when the pick is the actual winner, 'wrong' when it lost, 'tie'
// for ties (no pick survives them), and null when there is no outcome yet (live or
// unplayed) or no pick to grade against.
export const pickAccuracy = (pick, game) => {
  if (!game || (!game.winner && !game.tied)) return null;
  if (game.tied) return 'tie';
  if (!pick) return null;
  return pick === game.winner ? 'correct' : 'wrong';
};



// ── Test Mode score fabrication ──────────────────────────────────────────────────
// Simulated weeks should look like real ones: every fabricated result carries
// plausible final scores built from touchdown (7) and field-goal (3) increments,
// with the simulated winner always holding the higher total. Outcomes are
// deterministic per matchup (seeded from the `away|home` key), so a simulated
// season is stable across re-renders and repeat visits, and ~2% of games tie so
// the survivor tie path (shared eliminations, T scoreboard rows) gets exercised.

export const SIM_TIE_CHANCE = 0.02;

// FNV-1a -> 32-bit seed, then mulberry32: tiny, dependency-free, deterministic.
const hashSeed = (key) => {
  let hash = 2166136261;
  for (const character of key) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};
const mulberry32 = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const scoredCombo = (rand, maxTouchdowns, maxFieldGoals) =>
  7 * Math.floor(rand() * (maxTouchdowns + 1)) + 3 * Math.floor(rand() * (maxFieldGoals + 1));

// Returns { tied, awayScore, homeScore }. `winnerIsHome` only matters for non-ties;
// ties use a low band because real NFL ties never reach the 30s.
export const simulateOutcome = (seedKey, winnerIsHome, tieChance = SIM_TIE_CHANCE) => {
  const rand = mulberry32(hashSeed(seedKey));
  if (rand() < tieChance) {
    const score = scoredCombo(rand, 3, 4);
    return { tied: true, awayScore: score, homeScore: score };
  }
  const winnerScore = scoredCombo(rand, 4, 4) + 7; // winner floor of 7 — no 3-0 snoozers
  let loserScore = scoredCombo(rand, 3, 4);
  while (loserScore >= winnerScore) loserScore = Math.max(0, loserScore - 3);
  return winnerIsHome
    ? { tied: false, awayScore: loserScore, homeScore: winnerScore }
    : { tied: false, awayScore: winnerScore, homeScore: loserScore };
};

// ── Missing results: detection, manual entry, fetch timing ──────────────────────
// The scores endpoint reaches back only 3 days, so any result not captured inside that
// window can never be recovered from the API. These helpers find those gaps, let the
// user type a score in by hand, and decide when a fetch is genuinely needed so gaps
// stop happening in the first place.

export const HOUR_MS = 60 * 60 * 1000;
export const GAME_DURATION_MS = 3.5 * HOUR_MS; // a game is over ~3.5h after kickoff
export const SCORES_LOOKBACK_DAYS = 3; // the API's daysFrom cap - past it, results are gone
export const PENDING_MIN_INTERVAL_MS = 15 * 60 * 1000; // never re-fetch gaps back to back

// Games that kicked off long enough ago to be final but still have no outcome. A game
// the API already reported as final-without-scores is not a gap (re-fetching can't help
// it), and neither is one still inside the game-length grace period. `recoverable` marks
// the ones still inside the API's 3-day window.
export const missingResults = (schedule, now = Date.now()) => (schedule || [])
  .filter((game) => {
    if (game.winner || game.tied || game.resultStatus === 'final') return false;
    const kickoff = new Date(game.kickoff).getTime();
    return Number.isFinite(kickoff) && now - kickoff >= GAME_DURATION_MS;
  })
  .map((game) => {
    const age = now - new Date(game.kickoff).getTime();
    return {
      week: game.week,
      away: game.away,
      home: game.home,
      kickoff: game.kickoff,
      recoverable: age <= SCORES_LOOKBACK_DAYS * 24 * HOUR_MS,
    };
  });

// Gaps worth surfacing: still recoverable from the API, or sitting in a week whose other
// games already have results - those weeks can never lock until they're filled. Whole-week
// gaps (history from before this browser ever fetched, e.g. a mid-season install) stay
// quiet so the notice never turns into permanent noise.
export const actionableGaps = (schedule, now = Date.now()) => {
  const decidedWeeks = new Set((schedule || []).filter((game) => game.winner || game.tied).map((game) => game.week));
  return missingResults(schedule, now).filter((game) => game.recoverable || decidedWeeks.has(game.week));
};

// Fetch decision: an uncaptured game that finished after the last successful fetch always
// wins - that is exactly how results aged out before - with a short floor so rapid reloads
// don't double-fetch. Otherwise fall back to the 6h auto gate.
export const shouldFetchNow = (results, schedule, now = Date.now()) => {
  const attemptedAt = results?.attemptedAt;
  if (attemptedAt && now - attemptedAt < PENDING_MIN_INTERVAL_MS) return false;
  // Timestamps are stored as numbers; a malformed/legacy value simply forces a fetch.
  const capturedAt = Number(results?.updatedAt) || 0;
  const uncaptured = (schedule || []).some((game) => {
    if (game.winner || game.tied || game.resultStatus === 'final') return false;
    const kickoff = new Date(game.kickoff).getTime();
    if (!Number.isFinite(kickoff) || now - kickoff < GAME_DURATION_MS) return false;
    return kickoff + GAME_DURATION_MS > capturedAt; // it finished after the last successful fetch
  });
  return uncaptured || shouldAutoFetch(results, now);
};

// ── Hand-entered results ────────────────────────────────────────────────────────
// Empty strings must not sneak through as 0, hence the explicit '' check.
const validScore = (value) =>
  value !== '' && value != null && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 199;

// A stored entry built from typed-in scores. Equal scores are a tie, which matters:
// survivor picks sharing a tied game are eliminated. Returns null for malformed input so
// the caller can reject the save instead of storing nonsense.
export const manualResultEntry = (game, awayScore, homeScore) => {
  if (!game || !validScore(awayScore) || !validScore(homeScore)) return null;
  const away = Number(awayScore);
  const home = Number(homeScore);
  return {
    status: 'final',
    tied: away === home,
    winner: away === home ? null : away > home ? game.away : game.home,
    awayScore: away,
    homeScore: home,
    kickoff: game.kickoff || null,
    lastUpdate: null,
    manual: true,
  };
};

// Store a hand-entered result. Manual entries survive live/scheduled API responses
// (see absorbEvents) but yield to a definite API final, so a typo self-heals if the API
// ever does report the game.
export const applyManualResult = (results, game, awayScore, homeScore) => {
  const entry = manualResultEntry(game, awayScore, homeScore);
  if (!entry) return false;
  results.games[`${game.away}|${game.home}`] = entry;
  return true;
};

export const clearManualResult = (results, game) => {
  const key = `${game.away}|${game.home}`;
  if (!results?.games?.[key]) return false;
  delete results.games[key];
  return true;
};
