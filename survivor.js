// Client-side survivor-pool helpers. Team ids deliberately match the names shown by
// the existing CBS-oriented UI, so saved picks stay portable between sample and live odds.
export const TEAMS = ['Cardinals','Falcons','Ravens','Bills','Panthers','Bears','Bengals','Browns','Cowboys','Broncos','Lions','Packers','Texans','Colts','Jaguars','Chiefs','Raiders','Chargers','Rams','Dolphins','Vikings','Patriots','Saints','Giants','Jets','Eagles','Steelers','49ers','Seahawks','Buccaneers','Titans','Commanders'];
export const TEAM_ABBREVIATIONS = {
  Cardinals: 'ARI', Falcons: 'ATL', Ravens: 'BAL', Bills: 'BUF', Panthers: 'CAR', Bears: 'CHI', Bengals: 'CIN', Browns: 'CLE', Cowboys: 'DAL', Broncos: 'DEN', Lions: 'DET', Packers: 'GB', Texans: 'HOU', Colts: 'IND', Jaguars: 'JAX', Chiefs: 'KC', Raiders: 'LV', Chargers: 'LAC', Rams: 'LAR', Dolphins: 'MIA', Vikings: 'MIN', Patriots: 'NE', Saints: 'NO', Giants: 'NYG', Jets: 'NYJ', Eagles: 'PHI', Steelers: 'PIT', '49ers': 'SF', Seahawks: 'SEA', Buccaneers: 'TB', Titans: 'TEN', Commanders: 'WAS',
};
const fullNames = Object.fromEntries(TEAMS.map((team) => [team, team]));
[
  ['Arizona Cardinals','Cardinals'],['Atlanta Falcons','Falcons'],['Baltimore Ravens','Ravens'],['Buffalo Bills','Bills'],['Carolina Panthers','Panthers'],['Chicago Bears','Bears'],['Cincinnati Bengals','Bengals'],['Cleveland Browns','Browns'],['Dallas Cowboys','Cowboys'],['Denver Broncos','Broncos'],['Detroit Lions','Lions'],['Green Bay Packers','Packers'],['Houston Texans','Texans'],['Indianapolis Colts','Colts'],['Jacksonville Jaguars','Jaguars'],['Kansas City Chiefs','Chiefs'],['Las Vegas Raiders','Raiders'],['Los Angeles Chargers','Chargers'],['Los Angeles Rams','Rams'],['Miami Dolphins','Dolphins'],['Minnesota Vikings','Vikings'],['New England Patriots','Patriots'],['New Orleans Saints','Saints'],['New York Giants','Giants'],['New York Jets','Jets'],['Philadelphia Eagles','Eagles'],['Pittsburgh Steelers','Steelers'],['San Francisco 49ers','49ers'],['Seattle Seahawks','Seahawks'],['Tampa Bay Buccaneers','Buccaneers'],['Tennessee Titans','Titans'],['Washington Commanders','Commanders'],
].forEach(([full, short]) => { fullNames[full] = short; });

export const teamId = (name) => fullNames[name] || name;
export const createPool = () => ({ version: 1, entries: [], myEntryId: '', publicBehavior: 'chalk' });

export const buildSchedule = (rawGames) => {
  const games = [...(rawGames || [])]
    .map((game) => ({ home: teamId(game.home_team), away: teamId(game.away_team), kickoff: game.commence_time, winner: game.winner ? teamId(game.winner) : null, tied: !!game.tied }))
    .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  if (!games.length) return [];
  // Week assignment: the NFL season opens on a Thursday, and every week thereafter
  // runs Thu -> the following Monday night (the MNF doubleheaders kick right after
  // midnight UTC into the next UTC day). Bucketing whole 7-day blocks from the
  // opener's OWN day (midnight UTC, NOT the Tuesday before it) keeps every game —
  // including Monday-night games recorded as the following day in UTC — in the
  // correct NFL week. A 1-hour shift or Tuesday anchoring pushes those MNF games
  // into the wrong bucket (fake byes / double games).
  const start = new Date(games[0].kickoff);
  start.setUTCHours(0, 0, 0, 0);
  return games.map((game) => ({ ...game, week: Math.min(18, Math.floor((new Date(game.kickoff) - start) / 604800000) + 1) }));
};

export const eloProbability = (homeRating = 1500, awayRating = 1500) => 1 / (1 + 10 ** -((homeRating + 55 - awayRating) / 400));

export const buildForecasts = (schedule, liveGames, probabilityForLive) => {
  const ratings = Object.fromEntries(TEAMS.map((team) => [team, 1500]));
  const live = new Map((liveGames || []).map((game) => [`${game.away}|${game.home}`, game]));
  return schedule.map((game) => {
    const key = `${game.away}|${game.home}`;
    const liveGame = live.get(key);
    let homeProbability = eloProbability(ratings[game.home], ratings[game.away]);
    let source = 'Elo fallback';
    if (liveGame) {
      const favoriteProbability = probabilityForLive(liveGame);
      homeProbability = liveGame.favorite === liveGame.home ? favoriteProbability : 1 - favoriteProbability;
      source = liveGame.marketProb == null ? 'Model' : 'Market blend';
    }
    const forecast = { ...game, homeProbability, awayProbability: 1 - homeProbability, source };
    if (game.winner && !game.tied) {
      const actualHome = game.winner === game.home ? 1 : 0;
      const delta = 20 * (actualHome - homeProbability);
      ratings[game.home] += delta;
      ratings[game.away] -= delta;
    }
    return forecast;
  });
};

// A week counts as complete only when EVERY game in it has a result — a Thursday
// win must not lock the rest of the week's picks while Sunday games are still ahead.
// Weeks resolve in order, so the scan stops at the first unfinished week: done weeks
// are always a 1..N prefix, never a scattered set.
export const completedWeek = (schedule) => {
  let done = 0;
  for (let week = 1; week <= 18; week += 1) {
    const games = (schedule || []).filter((game) => game.week === week);
    if (!games.length || !games.every((game) => game.winner || game.tied)) break;
    done = week;
  }
  return done;
};

// Grades a pick history. Eliminations are graded against the picked team's own game
// result — not against whole-week completion — so a Thursday loss eliminates while
// the rest of the week (and the week-level lock) is still in progress. upToWeek
// scopes the elimination check to the viewed week (per-week display); the used set
// and error checks always stay season-wide.
export const validateEntry = (entry, schedule, upToWeek = null) => {
  const used = new Set();
  const errors = [];
  let eliminated = false;
  let eliminatedWeek = null;
  for (const [weekText, rawTeam] of Object.entries(entry.picks || {})) {
    const week = Number(weekText);
    const team = teamId(rawTeam);
    if (!team) continue;
    const games = schedule.filter((game) => game.week === week);
    const game = games.find((candidate) => candidate.home === team || candidate.away === team);
    if (!TEAMS.includes(team)) errors.push(`Week ${week}: unknown team`);
    else if (used.has(team)) errors.push(`Week ${week}: ${team} was already used`);
    else if (!game) errors.push(`Week ${week}: ${team} does not play`);
    else {
      used.add(team);
      if ((upToWeek === null || week <= upToWeek) && (game.tied || (game.winner && game.winner !== team))) {
        // First losing/tied week = the week the entry actually went out.
        if (eliminatedWeek === null) eliminatedWeek = week;
        eliminated = true;
      }
    }
  }
  return { used, errors, status: errors.length ? 'Invalid history' : eliminated ? 'Eliminated' : 'Active', eliminatedWeek };
};

export const currentWeek = (schedule, currentGames) => {
  const keys = new Set((currentGames || []).map((game) => `${game.away}|${game.home}`));
  return schedule.find((game) => keys.has(`${game.away}|${game.home}`))?.week || 1;
};

const choicesForWeek = (games, used) => games.flatMap((game) => [
  !used.has(game.home) && { team: game.home, probability: game.homeProbability, source: game.source },
  !used.has(game.away) && { team: game.away, probability: game.awayProbability, source: game.source },
].filter(Boolean));

export const bestPaths = (forecasts, startWeek, usedTeams, limit = 2000) => {
  let states = [{ used: new Set(usedTeams), logProbability: 0, picks: [] }];
  for (let week = startWeek; week <= 18; week += 1) {
    const games = forecasts.filter((game) => game.week === week && !game.winner && !game.tied);
    if (!games.length) continue;
    states = states.flatMap((state) => choicesForWeek(games, state.used).map((choice) => ({
      used: new Set([...state.used, choice.team]), logProbability: state.logProbability + Math.log(Math.max(choice.probability, 0.001)), picks: [...state.picks, { week, ...choice }],
    }))).sort((a, b) => b.logProbability - a.logProbability).slice(0, limit);
  }
  return states;
};

export const survivalAdvice = (forecasts, startWeek, used) => {
  const paths = bestPaths(forecasts, startWeek, used);
  const best = paths[0];
  return best ? { ...best, survivalProbability: Math.exp(best.logProbability) } : null;
};

const seeded = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const behaviorPower = { chalk: 8, balanced: 3, contrarian: 1 };
const weightedChoice = (choices, power, random) => {
  const total = choices.reduce((sum, choice) => sum + choice.probability ** power, 0);
  let target = random() * total;
  for (const choice of choices) { target -= choice.probability ** power; if (target <= 0) return choice; }
  return choices.at(-1);
};

// Deterministic Monte Carlo: exact used-team sets are respected; future opponent
// behavior is the chosen public-distribution assumption, not claimed pick data.
export const leverageAdvice = (forecasts, startWeek, myUsed, opponentUsed, behavior = 'chalk', runs = 10000) => {
  const currentChoices = choicesForWeek(forecasts.filter((game) => game.week === startWeek), myUsed);
  if (!currentChoices.length) return null;
  const power = behaviorPower[behavior] || behaviorPower.chalk;
  const random = seeded(20260910);
  const results = currentChoices.map((candidate) => ({ ...candidate, titleShare: 0, ownership: 0 }));
  for (const result of results) {
    // Leverage evaluates every current candidate. A smaller beam keeps that view
    // interactive; the displayed survival path still uses the full 2,000-state beam.
    const candidatePaths = bestPaths(forecasts, startWeek + 1, new Set([...myUsed, result.team]), 150);
    const myPlan = candidatePaths[0] ? { picks: candidatePaths[0].picks } : null;
    for (let run = 0; run < runs; run += 1) {
      let alive = result.probability > random() ? 1 : 0;
      let totalAlive = alive;
      for (const used of opponentUsed) {
        const pick = weightedChoice(choicesForWeek(forecasts.filter((game) => game.week === startWeek), used), power, random);
        if (pick?.team === result.team) result.ownership += 1 / runs;
        if (pick && pick.probability > random()) totalAlive += 1;
      }
      // Future survival follows the selected entrant's optimal plan. Opponents are
      // conservatively counted as still alive after a current-week win; the score is
      // a title-share proxy rather than a claimed exact pool forecast.
      if (alive && myPlan) {
        for (const pick of myPlan.picks) if (pick.probability <= random()) { alive = 0; break; }
      }
      if (alive) result.titleShare += 1 / Math.max(1, totalAlive);
    }
    result.titleShare /= runs;
  }
  return results.sort((a, b) => b.titleShare - a.titleShare)[0];
};
