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
