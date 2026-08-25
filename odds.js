import getSampleData from './sampledata.js';

// ── Win-probability model ────────────────────────────────────────────────────────
// Goal: turn a consensus spread + total (over/under) into the probability that the
// favorite wins outright.
//
// Assumption: the favorite's final margin of victory follows a bell curve (normal
// distribution) centered on the spread. This matches decades of research showing NFL
// margins are close to normal, and it is implicitly how books convert spreads into
// moneylines. The win probability is then just the area under that curve right of
// zero: margin ~ Normal(mean = spread, sd = sigma), so P(win) = Φ(spread / sigma).

const MARGIN_SD_AT_BASELINE = 13.5;
// How random one NFL game is: in an average-scoring game, actual final margins miss
// expectations by ~13-14 points on average (Stern 1991 estimated ~13.3). This single
// number caps how confident anyone can be — it's why a -10 favorite still only wins
// about 77% of the time.

const BASELINE_TOTAL = 44;
// Reference scoring environment: historically the average NFL game totals ~44 combined
// points. Sigma equals MARGIN_SD_AT_BASELINE when the total is exactly this.
//
// High-scoring games are noisier than low-scoring ones: each team's score carries more
// random variance, and the margin (a difference of two noisy scores) inherits it.
// Treating scoring noise as independent counting statistics makes sd grow with the
// square root of the total, hence: sigma(total) = 13.5 * sqrt(total / 44).
// Example: a -7 favorite at total 38 wins ~71% of the time, but only ~68% at total 56.

const erf = (x) => {
  // The "error function". The normal curve's CDF has no closed-form formula, so
  // statistics expresses it as Φ(z) = 1/2 * [1 + erf(z / √2)] and evaluates erf
  // numerically. JavaScript's Math object has no built-in erf, hence this helper.
  //
  // Abramowitz & Stegun, Handbook of Mathematical Functions (1964), formula 7.1.26:
  // a rational-polynomial curve fit accurate to within ~1.5e-7 everywhere. The decimal
  // constants below are fitted weights from that formula, not meaningful quantities.
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absX); // p = 0.3275911 from A&S 7.1.26
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * // coefficients a5..a1 from A&S 7.1.26
      t *
      Math.exp(-absX * absX);
  return sign * y;
};

const getWinProbability = (aveSpread, aveTotal) => {
  // P(favorite wins), modeling the margin as Normal(aveSpread, sigma(aveTotal)).
  // aveSpread must be positive (the favorite-signed magnitude).
  const sigma = MARGIN_SD_AT_BASELINE * Math.sqrt(Math.max(aveTotal, BASELINE_TOTAL / 2) / BASELINE_TOTAL); // floor guards against glitched totals collapsing sigma toward zero
  // Standard normal CDF written via erf: Φ(z) = 0.5 * (1 + erf(z / sqrt(2)))
  return 0.5 * (1 + erf(aveSpread / (sigma * Math.SQRT2)));
};

const callOddsAPI = async (apiKey) => {
  try {
    const oddsResponse = await fetch(
      `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?` +
        new URLSearchParams({
          apiKey: apiKey,
          regions: 'us',
          markets: 'spreads,totals',
          oddsFormat: 'decimal',
          dateFormat: 'iso',
        }),
      {
        mode: 'cors',
      },
    );

    if (await !oddsResponse.ok)
      throw new Error(
        `Failed to get odds: status_code ${oddsResponse.status_code}, response body ${oddsResponse.text}`,
      );
    const data = await oddsResponse.json();
    const usage = {
      used: +oddsResponse.headers.get('x-requests-used'),
      remaining: +oddsResponse.headers.get('x-requests-remaining'),
    };
    return { data, usage };
  } catch (error) {
    console.error(error);
    return null;
  }
};

const getOddsData = async (apiKey = null) => {
  const { data, usage } = apiKey ? await callOddsAPI(apiKey) : await getSampleData();
  if (!data) return null;

  const rankings = [];
  const tiebreaker = {
    away: '',
    home: '',
    aveTotal: 0,
    commence: new Date(-8640000000000000),
  };

  // Find the start and end dates for data filtering
  const today = new Date();
  const firstGameDate = new Date(data[0].commence_time);
  const targetDate = !apiKey || today < firstGameDate ? firstGameDate : today;
  const nextTues = getNextTuesday(targetDate); // the upcoming Tues which has yet to pass
  const lastTues = new Date(nextTues);
  lastTues.setDate(nextTues.getDate() - 7); // the most recent Tues, including targetDate if it is Tues

  // Filter for the current week's games
  const currentWeeksGames = data.filter(
    (game) => new Date(game.commence_time) >= lastTues && new Date(game.commence_time) < nextTues,
  );

  // Main data processing loop
  currentWeeksGames.forEach((game) => {
    const home = game.home_team;
    const away = game.away_team;
    const commence = new Date(game.commence_time);
    const totals = []; // Total game points per each bookmaker (e.g. [ 52.5, 52, … ])
    const spreads = {}; // Spreads for each team (e.g. { "Atlanta Falcons": […], "Carolina Panthers": […] })
    spreads[home] = []; // Spreads for the home team per each bookmaker (e.g. [ -3.5, -3.5, -3.5, … ])
    spreads[away] = []; // Spreads for the away team per each bookmaker (e.g. [ 3.5, 3.5, 3.5, … ])

    // Get spreads and totals from each bookmaker
    game.bookmakers.forEach((bookmaker) => {
      bookmaker.markets.forEach((market) => {
        if (market.key === 'spreads') {
          market.outcomes.forEach((team) => {
            spreads[team.name].push(+team.point);
          });
        }
        if (market.key === 'totals') {
          totals.push(+market['outcomes'][0]['point']);
        }
      });
    });

    // Average the projections from each bookmaker. Spreads are equal and opposite, so we only need to look at one
    // team and then can look at the sign later to determine favored team
    let aveSpread = spreads[home].reduce((a, b) => a + b, 0) / spreads[home].length;
    const aveTotal = totals.length
      ? totals.reduce((a, b) => a + b, 0) / totals.length
      : BASELINE_TOTAL; // fallback if no bookmaker posted a total

    // Check for tiebreaker game (total score for the last game of the week)
    if (commence > tiebreaker.commence) {
      tiebreaker.away = away;
      tiebreaker.home = home;
      tiebreaker.aveTotal = aveTotal;
      tiebreaker.commence = commence;
    }

    // Update the rankings list. Average spread is initialized as the average point spread for the home team
    let favorite = home;
    if (aveSpread > 0) {
      favorite = away;
      aveSpread *= -1;
    }
    rankings.push({
      away,
      home,
      favorite,
      aveSpread,
      aveTotal,
      commence,
      winProbability: getWinProbability(Math.abs(aveSpread), aveTotal),
    });
  });

  // Sort the rankings and adjust names and number formatting
  const sortedRankings = rankings.sort((a, b) => b.winProbability - a.winProbability);
  sortedRankings.map((game) => {
    game.away = getCBSName(game.away);
    game.home = getCBSName(game.home);
    game.favorite = getCBSName(game.favorite);
    game.aveSpread = Math.round(game.aveSpread * 10) / 10;
    game.aveTotal = Math.round(game.aveTotal);
    return game;
  });

  tiebreaker.away = getCBSName(tiebreaker.away);
  tiebreaker.home = getCBSName(tiebreaker.home);
  tiebreaker.aveTotal = Math.round(tiebreaker.aveTotal);

  return { sortedRankings, tiebreaker, usage };
};

const getNextTuesday = (inputDate = new Date()) => {
  // Returns the date value for the Tuesday which follows inputDate, exclusive
  // of inputDate (i.e. if inputDate is a Tuesday, it will return the following Tuesday)
  if (!(inputDate instanceof Date) || isNaN(inputDate)) {
    console.error("Invalid date provided. Using today's date instead.");
    inputDate = new Date();
  }

  const date = new Date(inputDate);
  const currentDay = date.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const daysUntilNextTues = ((8 - currentDay) % 7) + 1;
  const nextTues = new Date(date);
  nextTues.setDate(date.getDate() + daysUntilNextTues);
  return nextTues;
};

const getCBSName = (inputName) => {
  // Formats the inputName to match the team names on CBS Pick'Em site for better readability
  const cbsNames = {
    'Arizona Cardinals': 'Cardinals',
    'Atlanta Falcons': 'Falcons',
    'Baltimore Ravens': 'Ravens',
    'Buffalo Bills': 'Bills',
    'Carolina Panthers': 'Panthers',
    'Chicago Bears': 'Bears',
    'Cincinnati Bengals': 'Bengals',
    'Cleveland Browns': 'Browns',
    'Dallas Cowboys': 'Cowboys',
    'Denver Broncos': 'Broncos',
    'Detroit Lions': 'Lions',
    'Green Bay Packers': 'Packers',
    'Houston Texans': 'Texans',
    'Indianapolis Colts': 'Colts',
    'Jacksonville Jaguars': 'Jaguars',
    'Kansas City Chiefs': 'Chiefs',
    'Las Vegas Raiders': 'Raiders',
    'Los Angeles Chargers': 'Chargers',
    'Los Angeles Rams': 'Rams',
    'Miami Dolphins': 'Dolphins',
    'Minnesota Vikings': 'Vikings',
    'New England Patriots': 'Patriots',
    'New Orleans Saints': 'Saints',
    'New York Giants': 'Giants',
    'New York Jets': 'Jets',
    'Philadelphia Eagles': 'Eagles',
    'Pittsburgh Steelers': 'Steelers',
    'San Francisco 49ers': '49ers',
    'Seattle Seahawks': 'Seahawks',
    'Tampa Bay Buccaneers': 'Buccaneers',
    'Tennessee Titans': 'Titans',
    'Washington Commanders': 'Commanders',
  };

  if (inputName in cbsNames) return cbsNames[inputName];

  console.error(`'${inputName}' does not exist in CBS name dictionary. Could not rename.`);
  return inputName;
};

export default getOddsData;
