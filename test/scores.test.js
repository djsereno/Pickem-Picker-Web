import test from 'node:test';
import assert from 'node:assert/strict';
import {
  absorbEvents, buildWeekBoardRows, createResults, loadResults, mapScoreEvents,
  mergeResults, pickAccuracy, saveResults, shouldAutoFetch, simulateOutcome, SCORES_THROTTLE_MS,
} from '../scores.js';
import { buildSchedule } from '../survivor.js';

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


