import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule, eloProbability, validateEntry, bestPaths, leverageAdvice } from '../survivor.js';

const raw = [
  { home_team: 'Buffalo Bills', away_team: 'New York Jets', commence_time: '2026-09-10T00:15:00Z', winner: 'Buffalo Bills' },
  { home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos', commence_time: '2026-09-17T00:15:00Z' },
];
test('schedule normalizes teams and assigns weeks', () => {
  const schedule = buildSchedule(raw);
  assert.equal(schedule[0].home, 'Bills');
  assert.equal(schedule[1].week, 2);
});
test('entry validation catches losses and duplicate teams', () => {
  const schedule = buildSchedule(raw);
  assert.equal(validateEntry({ picks: { 1: 'Jets' } }, schedule, 1).status, 'Eliminated');
  assert.match(validateEntry({ picks: { 1: 'Bills', 2: 'Bills' } }, schedule).errors[0], /already used/);
});
test('elo home advantage produces a probability above one half', () => assert.ok(eloProbability() > 0.5));
test('path search preserves team one-use constraint', () => {
  const forecasts = [{ week: 1, home: 'Bills', away: 'Jets', homeProbability: .8, awayProbability: .2 }, { week: 2, home: 'Bills', away: 'Chiefs', homeProbability: .9, awayProbability: .1 }];
  const path = bestPaths(forecasts, 1, new Set(), 5)[0];
  assert.notEqual(path.picks[0].team, path.picks[1].team);
});
test('a tied completed game eliminates an entry and leverage is deterministic', () => {
  const schedule = buildSchedule([{ home_team: 'Buffalo Bills', away_team: 'New York Jets', commence_time: '2026-09-10T00:15:00Z', tied: true }]);
  assert.equal(validateEntry({ picks: { 1: 'Bills' } }, schedule, 1).status, 'Eliminated');
  const forecasts = [{ week: 1, home: 'Bills', away: 'Jets', homeProbability: .8, awayProbability: .2 }, { week: 2, home: 'Chiefs', away: 'Broncos', homeProbability: .75, awayProbability: .25 }];
  const first = leverageAdvice(forecasts, 1, new Set(), [new Set()], 'chalk', 20);
  const second = leverageAdvice(forecasts, 1, new Set(), [new Set()], 'chalk', 20);
  assert.deepEqual(first, second);
});
test('simulating a completed week eliminates entries that picked the loser', () => {
  // Mirrors what the ?sim=1 harness does: set winners on a week's games, then the app's
  // completedWeek-derived logic (max week with a result) locks it and validateEntry flags losses.
  const schedule = buildSchedule([
    { home_team: 'Buffalo Bills', away_team: 'New York Jets', commence_time: '2026-09-10T00:15:00Z', winner: 'Buffalo Bills' },
    { home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos', commence_time: '2026-09-17T00:15:00Z' },
  ]);
  const done = Math.max(0, ...schedule.filter((game) => game.winner || game.tied).map((game) => game.week));
  assert.equal(done, 1);                              // week 1 is now complete
  assert.equal(validateEntry({ picks: { 1: 'Jets' } }, schedule, done).status, 'Eliminated');
  assert.equal(validateEntry({ picks: { 1: 'Bills' } }, schedule, done).status, 'Active');
  assert.equal(validateEntry({ picks: { 2: 'Chiefs' } }, schedule, done).status, 'Active'); // future week untouched
});
test('status on a weekly tab reflects that week, not later eliminations', () => {
  const schedule = buildSchedule([
    { home_team: 'Buffalo Bills', away_team: 'New York Jets', commence_time: '2026-09-10T00:15:00Z', winner: 'Buffalo Bills' },
    { home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos', commence_time: '2026-09-17T00:15:00Z', winner: 'Denver Broncos' },
  ]);
  const entry = { picks: { 1: 'Bills', 2: 'Chiefs' } };
  assert.equal(validateEntry(entry, schedule, 2).status, 'Eliminated');    // season-wide: out after the W2 loss
  assert.equal(validateEntry(entry, schedule, 2, 1).status, 'Active');     // as of W1 they were still alive
  assert.equal(validateEntry(entry, schedule, 2, 2).status, 'Eliminated'); // as of W2 they are out
  assert.equal(validateEntry(entry, schedule, 2, 1).used.has('Chiefs'), true); // used-set stays season-wide
});
test('eliminatedWeek reports the week the entry actually went out', () => {
  const schedule = buildSchedule([
    { home_team: 'Buffalo Bills', away_team: 'New York Jets', commence_time: '2026-09-10T00:15:00Z', winner: 'Buffalo Bills' },
    { home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos', commence_time: '2026-09-17T00:15:00Z', winner: 'Denver Broncos' },
  ]);
  // Out in W2 (Chiefs lost): elimination week is 2, not 1 — so W2 itself is not dimmed.
  const late = validateEntry({ picks: { 1: 'Bills', 2: 'Chiefs' } }, schedule, 2);
  assert.equal(late.eliminatedWeek, 2);
  // Out in W1 (Jets lost immediately).
  const early = validateEntry({ picks: { 1: 'Jets' } }, schedule, 1);
  assert.equal(early.eliminatedWeek, 1);
  // Still alive: no elimination week.
  const alive = validateEntry({ picks: { 1: 'Bills' } }, schedule, 1);
  assert.equal(alive.eliminatedWeek, null);
  // Week-scoped call: a later loss is not visible yet.
  assert.equal(validateEntry({ picks: { 1: 'Bills', 2: 'Chiefs' } }, schedule, 2, 1).eliminatedWeek, null);
});
