import test from 'node:test';
import assert from 'node:assert/strict';
import {
  absorbEvents, actionableGaps, applyManualResult, buildWeekBoardRows, clearManualResult,
  createResults, loadResults, manualResultEntry, mapScoreEvents, mergeResults, missingResults,
  pickAccuracy, saveResults, shouldAutoFetch, shouldFetchNow, simulateOutcome, SCORES_THROTTLE_MS,
} from '../scores.js';
import { buildSchedule, completedWeek } from '../survivor.js';

const event = (overrides = {}) => ({
  id: 'e1',
  sport_key: 'americanfootball_nfl',
  sport_title: 'NFL',
  commence_time: '2026-09-11T00:15:00Z',
  completed: true,
  home_team: 'Kansas City Chiefs',
  away_team: 'Denver Broncos',
  scores: [
    { name: 'Denver Broncos', score: '20' },
    { name: 'Kansas City Chiefs', score: '27' },
  ],
  last_update: '2026-09-11T03:30:00Z',
  ...overrides,
});

test('completed games derive the winner from string scores', () => {
  const entry = mapScoreEvents([event()]).get('Broncos|Chiefs');
  assert.equal(entry.status, 'final');
  assert.equal(entry.winner, 'Chiefs');
  assert.equal(entry.tied, false);
  assert.equal(entry.awayScore, 20);
  assert.equal(entry.homeScore, 27);
});

test('equal final scores produce a tie (survivor eliminations depend on it)', () => {
  const entry = mapScoreEvents([event({
    scores: [{ name: 'Denver Broncos', score: '20' }, { name: 'Kansas City Chiefs', score: '20' }],
  })]).get('Broncos|Chiefs');
  assert.equal(entry.tied, true);
  assert.equal(entry.winner, null);
});

test('in-progress games carry scores but never a winner', () => {
  const entry = mapScoreEvents([event({ completed: false })]).get('Broncos|Chiefs');
  assert.equal(entry.status, 'live');
  assert.equal(entry.winner, null);
  assert.equal(entry.tied, false);
  assert.equal(entry.awayScore, 20);
  assert.equal(entry.homeScore, 27);
});

test('unstarted games are scheduled with no scores', () => {
  const entry = mapScoreEvents([event({ completed: false, scores: [], last_update: null })]).get('Broncos|Chiefs');
  assert.equal(entry.status, 'scheduled');
  assert.equal(entry.awayScore, null);
  assert.equal(entry.homeScore, null);
});

test('a completed game without reportable scores still reads as final (no fabricated winner)', () => {
  const entry = mapScoreEvents([event({ scores: [] })]).get('Broncos|Chiefs');
  assert.equal(entry.status, 'final');
  assert.equal(entry.winner, null);
  assert.equal(entry.awayScore, null);
});


test('non-numeric scores are ignored rather than mis-parsed', () => {
  const entry = mapScoreEvents([event({
    scores: [{ name: 'Denver Broncos', score: '' }, { name: 'Kansas City Chiefs', score: '27' }],
  })]).get('Broncos|Chiefs');
  assert.equal(entry.awayScore, null);
  assert.equal(entry.homeScore, 27);
  assert.equal(entry.winner, null); // one side missing -> no winner can be derived
});

test('merge applies results onto the schedule with normalized names', () => {
  const schedule = buildSchedule([
    { home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos', commence_time: '2026-09-11T00:15:00Z' },
  ]);
  const applied = mergeResults(schedule, absorbEvents(createResults(), [event()]));
  assert.equal(applied, 1);
  assert.equal(schedule[0].winner, 'Chiefs');
  assert.equal(schedule[0].tied, false);
  assert.equal(schedule[0].awayScore, 20);
  assert.equal(schedule[0].homeScore, 27);
  assert.equal(schedule[0].resultStatus, 'final');
});

test('final API results take precedence over hand-entered fixture fields', () => {
  const schedule = buildSchedule([
    { home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos', commence_time: '2026-09-11T00:15:00Z', winner: 'Denver Broncos' },
  ]);
  mergeResults(schedule, absorbEvents(createResults(), [event()]));
  assert.equal(schedule[0].winner, 'Chiefs'); // the real result overrides the stopgap entry
});

test('live entries never clear a known fixture result', () => {
  const schedule = buildSchedule([
    { home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos', commence_time: '2026-09-11T00:15:00Z', winner: 'Kansas City Chiefs' },
  ]);
  mergeResults(schedule, absorbEvents(createResults(), [event({ completed: false })]));
  assert.equal(schedule[0].winner, 'Chiefs'); // buildSchedule normalizes the fixture's full name
  assert.notEqual(schedule[0].awayScore, 20); // live scores are not attached over a final result
});

test('tied results set tied and clear winner on the schedule', () => {
  const schedule = buildSchedule([
    { home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos', commence_time: '2026-09-11T00:15:00Z' },
  ]);
  mergeResults(schedule, absorbEvents(createResults(), [event({
    scores: [{ name: 'Denver Broncos', score: '20' }, { name: 'Kansas City Chiefs', score: '20' }],
  })]));
  assert.equal(schedule[0].tied, true);
  assert.equal(schedule[0].winner, null);
});

test('results storage round-trips through localStorage', () => {
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, value),
  };
  try {
    const results = absorbEvents(createResults(), [event()]);
    results.updatedAt = 1234;
    results.attemptedAt = 1234;
    saveResults(results);
    const loaded = loadResults();
    assert.equal(loaded.games['Broncos|Chiefs'].winner, 'Chiefs');
    assert.equal(loaded.updatedAt, 1234);
    assert.equal(loaded.attemptedAt, 1234);
  } finally {
    delete globalThis.localStorage;
  }
});

test('corrupt or missing storage falls back to a fresh store', () => {
  globalThis.localStorage = { getItem: () => '{oops', setItem: () => {} };
  try {
    assert.deepEqual(loadResults(), createResults());
  } finally {
    delete globalThis.localStorage;
  }
});

test('auto-fetch throttle waits the full interval between attempts', () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldAutoFetch(createResults(), now), true); // never attempted
  assert.equal(shouldAutoFetch({ attemptedAt: now - SCORES_THROTTLE_MS + 1000 }, now), false);
  assert.equal(shouldAutoFetch({ attemptedAt: now - SCORES_THROTTLE_MS - 1000 }, now), true);
});

test('week board rows classify final/live/open and rank open games', () => {
  const schedule = buildSchedule([
    { home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos', commence_time: '2026-09-11T00:15:00Z' },
    { home_team: 'Buffalo Bills', away_team: 'New York Jets', commence_time: '2026-09-14T23:15:00Z' },
  ]);
  mergeResults(schedule, absorbEvents(createResults(), [event({ completed: false })]));
  const forecasts = [
    { week: 1, home: 'Chiefs', away: 'Broncos', homeProbability: 0.7, awayProbability: 0.3, source: 'Market blend' },
    { week: 1, home: 'Bills', away: 'Jets', homeProbability: 0.55, awayProbability: 0.45, source: 'Elo fallback' },
  ];
  const rows = buildWeekBoardRows(schedule, forecasts, 1);
  assert.deepEqual(rows.map((row) => row.home), ['Chiefs', 'Bills']); // kickoff order preserved
  const chiefs = rows.find((row) => row.home === 'Chiefs');
  assert.equal(chiefs.type, 'live'); // scores in, no winner yet
  assert.equal(chiefs.awayScore, 20);
  const bills = rows.find((row) => row.home === 'Bills');
  assert.equal(bills.type, 'open');
  assert.equal(bills.probability, 0.55);
  assert.equal(bills.favorite, 'Bills');
  assert.equal(bills.source, 'Elo fallback');
});

test('week board rows fall back to even odds when no forecast exists', () => {
  const schedule = buildSchedule([
    { home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos', commence_time: '2026-09-11T00:15:00Z' },
  ]);
  const rows = buildWeekBoardRows(schedule, [], 1);
  assert.equal(rows[0].type, 'open');
  assert.equal(rows[0].probability, 0.5);
  assert.equal(rows[0].source, 'Elo fallback');
});

test('simulated outcomes are deterministic per matchup', () => {
  const first = simulateOutcome('Jets|Bills', false);
  const second = simulateOutcome('Jets|Bills', false);
  assert.deepEqual(first, second);
});

test('simulated scores are plausible 7/3-point combinations consistent with the winner', () => {
  const isLegalCombo = (score) => [0, 1, 2, 3, 4, 5].some((td) => score - 7 * td >= 0 && (score - 7 * td) % 3 === 0);
  const keys = ['A|B', 'C|D', 'E|F', 'G|H', 'I|J', 'K|L', 'M|N', 'O|P', 'Q|R', 'S|T'];
  for (const key of keys) {
    for (const winnerIsHome of [true, false]) {
      const outcome = simulateOutcome(key, winnerIsHome);
      for (const score of [outcome.awayScore, outcome.homeScore]) {
        assert.equal(Number.isInteger(score), true);
        assert.equal(isLegalCombo(score), true, `${score} is not a TD/FG combination`);
        assert.equal(score >= 0 && score <= 47, true, `${score} outside a plausible range`);
      }
      if (outcome.tied) {
        assert.equal(outcome.awayScore, outcome.homeScore);
        assert.equal(outcome.awayScore <= 33, true, 'ties should stay out of the 30s');
      } else if (winnerIsHome) {
        assert.equal(outcome.homeScore > outcome.awayScore, true, 'home winner must outscore the away side');
        assert.equal(outcome.homeScore >= 7, true, 'winner floor of 7');
      } else {
        assert.equal(outcome.awayScore > outcome.homeScore, true, 'away winner must outscore the home side');
        assert.equal(outcome.awayScore >= 7, true, 'winner floor of 7');
      }
    }
  }
});

test('tie chance is a knob: forced ties and tie-free seasons both work', () => {
  const forced = simulateOutcome('Jets|Bills', true, 1);
  assert.equal(forced.tied, true);
  assert.equal(forced.awayScore, forced.homeScore);
  const tieFree = simulateOutcome('Jets|Bills', false, 0);
  assert.equal(tieFree.tied, false);
  assert.equal(tieFree.awayScore !== tieFree.homeScore, true);
});

test('pickAccuracy grades the model pick against the decided outcome', () => {
  assert.equal(pickAccuracy('Chiefs', { winner: 'Chiefs', tied: false }), 'correct');
  assert.equal(pickAccuracy('Broncos', { winner: 'Chiefs', tied: false }), 'wrong');
  // Ties grade every pick as a tie, whichever side was recommended.
  assert.equal(pickAccuracy('Chiefs', { winner: null, tied: true }), 'tie');
  assert.equal(pickAccuracy('Broncos', { winner: null, tied: true }), 'tie');
  // Nothing to grade: no pick available, or the game is live/unplayed.
  assert.equal(pickAccuracy(null, { winner: 'Chiefs', tied: false }), null);
  assert.equal(pickAccuracy('Chiefs', { winner: null, tied: false }), null);
  assert.equal(pickAccuracy('Chiefs', null), null);
});

// ── Missing results, manual entry and fetch timing ──────────────────────────────

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0); // fixed "now" keeps the age math deterministic
const hoursAgo = (hours) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();
const daysAgo = (days) => hoursAgo(days * 24);

test('missingResults flags finished games with no outcome, marking recoverability', () => {
  const schedule = buildSchedule([
    { home_team: 'Buffalo Bills', away_team: 'New York Jets', commence_time: hoursAgo(5) },
    { home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos', commence_time: hoursAgo(1) },
    { home_team: 'Dallas Cowboys', away_team: 'Philadelphia Eagles', commence_time: daysAgo(5) },
    { home_team: 'Green Bay Packers', away_team: 'Chicago Bears', commence_time: hoursAgo(5), winner: 'Green Bay Packers' },
  ]);
  const byHome = Object.fromEntries(missingResults(schedule, NOW).map((game) => [game.home, game]));
  // The in-progress game (inside the 3.5h grace) and the decided game are not gaps.
  assert.deepEqual(Object.keys(byHome).sort(), ['Bills', 'Cowboys']);
  assert.equal(byHome.Bills.recoverable, true);   // finished 5h ago: still inside the API's 3-day window
  assert.equal(byHome.Cowboys.recoverable, false); // 5 days old: the API can no longer return it
});

test('a game the API reported final without scores is not treated as a gap', () => {
  const schedule = buildSchedule([
    { home_team: 'Buffalo Bills', away_team: 'New York Jets', commence_time: hoursAgo(5) },
  ]);
  schedule[0].resultStatus = 'final'; // completed, but the payload carried no scores
  assert.equal(missingResults(schedule, NOW).length, 0);
});

test('actionableGaps surfaces recoverable games and gaps inside started weeks', () => {
  // Recoverable: one click of Fetch scores still fixes it.
  const fresh = buildSchedule([
    { home_team: 'Buffalo Bills', away_team: 'New York Jets', commence_time: hoursAgo(5) },
  ]);
  assert.equal(actionableGaps(fresh, NOW).length, 1);
  // Lost but visible: its week has other results, so the week could otherwise never lock.
  const started = buildSchedule([
    { home_team: 'Dallas Cowboys', away_team: 'Philadelphia Eagles', commence_time: daysAgo(5) },
    { home_team: 'Green Bay Packers', away_team: 'Chicago Bears', commence_time: daysAgo(5) },
  ]);
  started[1].winner = 'Packers';
  assert.deepEqual(actionableGaps(started, NOW).map((game) => game.home), ['Cowboys']);
  // Quiet: an untouched old week (mid-season install) stays out of the notice.
  const untouched = buildSchedule([
    { home_team: 'Dallas Cowboys', away_team: 'Philadelphia Eagles', commence_time: daysAgo(10) },
    { home_team: 'Green Bay Packers', away_team: 'Chicago Bears', commence_time: daysAgo(10) },
  ]);
  assert.equal(actionableGaps(untouched, NOW).length, 0);
});

test('an uncaptured finished game forces a fetch even inside the 6h throttle', () => {
  const schedule = buildSchedule([
    { home_team: 'Buffalo Bills', away_team: 'New York Jets', commence_time: hoursAgo(5) },
  ]);
  const stale = { ...createResults(), attemptedAt: NOW - 2 * 60 * 60 * 1000, updatedAt: NOW - 30 * 24 * 60 * 60 * 1000 };
  assert.equal(shouldAutoFetch(stale, NOW), false);           // the 6h gate alone would skip the fetch
  assert.equal(shouldFetchNow(stale, schedule, NOW), true);   // the uncaptured result overrides it
});

test('fetch timing respects the pending floor and stays quiet when caught up', () => {
  const pending = buildSchedule([
    { home_team: 'Buffalo Bills', away_team: 'New York Jets', commence_time: hoursAgo(5) },
  ]);
  // Fetched a minute ago: never hammer the API while a gap is being chased.
  assert.equal(shouldFetchNow({ ...createResults(), attemptedAt: NOW - 60 * 1000 }, pending, NOW), false);
  // A game that only just kicked off is not finished yet, and the last fetch is recent.
  const inProgress = buildSchedule([
    { home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos', commence_time: hoursAgo(1) },
  ]);
  const caughtUp = { ...createResults(), attemptedAt: NOW - 2 * 60 * 60 * 1000, updatedAt: NOW - 60 * 60 * 1000 };
  assert.equal(shouldFetchNow(caughtUp, inProgress, NOW), false);
});

test('manual scores build a result entry and reject malformed input', () => {
  const game = { away: 'Broncos', home: 'Chiefs', kickoff: hoursAgo(5) };
  const homeWin = manualResultEntry(game, 20, 27);
  assert.equal(homeWin.winner, 'Chiefs');
  assert.equal(homeWin.tied, false);
  assert.equal(homeWin.awayScore, 20);
  assert.equal(homeWin.manual, true);
  assert.equal(manualResultEntry(game, 31, 24).winner, 'Broncos');
  const tie = manualResultEntry(game, 17, 17);
  assert.equal(tie.tied, true);
  assert.equal(tie.winner, null);
  // Malformed input must be rejected: '' cannot read as 0, and nothing out of range lands.
  assert.equal(manualResultEntry(game, '', 20), null);
  assert.equal(manualResultEntry(game, 'x', 20), null);
  assert.equal(manualResultEntry(game, 3.5, 20), null);
  assert.equal(manualResultEntry(game, -1, 20), null);
  assert.equal(manualResultEntry(game, 200, 20), null);
});

test('applied manual results decide a week and can be cleared', () => {
  const schedule = buildSchedule([
    { home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos', commence_time: hoursAgo(5) },
  ]);
  const results = createResults();
  assert.equal(applyManualResult(results, schedule[0], '20', '27'), true); // dialog values arrive as strings
  assert.equal(mergeResults(schedule, results), 1);
  assert.equal(schedule[0].winner, 'Chiefs');
  assert.equal(schedule[0].homeScore, 27);
  assert.equal(completedWeek(schedule), 1); // the typed result is a first-class outcome
  assert.equal(clearManualResult(results, schedule[0]), true);
  assert.equal(results.games['Broncos|Chiefs'], undefined);
});

test('manual entries survive inconclusive responses but yield to a real final', () => {
  const schedule = buildSchedule([
    { home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos', commence_time: hoursAgo(5) },
  ]);
  const results = createResults();
  applyManualResult(results, schedule[0], 20, 27);
  // The API still calls the game live: the typed score stands.
  absorbEvents(results, [event({ completed: false })]);
  assert.equal(results.games['Broncos|Chiefs'].manual, true);
  assert.equal(results.games['Broncos|Chiefs'].winner, 'Chiefs');
  // A definite API final replaces it, so a typo could self-heal later.
  absorbEvents(results, [event()]);
  assert.equal(results.games['Broncos|Chiefs'].manual, undefined);
  assert.equal(results.games['Broncos|Chiefs'].winner, 'Chiefs');
});
