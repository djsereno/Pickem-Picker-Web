import getSampleData from './sampledata.js';

const callOddsAPI = async (apiKey) => {
  try {
    const odds_response = await fetch(
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

    if (await !odds_response.ok)
      throw new Error(
        `Failed to get odds: status_code ${odds_response.status_code}, response body ${odds_response.text}`,
      );
    const data = await odds_response.json();
    const usage = {
      used: +odds_response.headers.get('x-requests-used'),
      remaining: +odds_response.headers.get('x-requests-remaining'),
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

  const firstGameDate = new Date(data[0].commence_time);
  const today = new Date();
  const targetDate = !apiKey || today < firstGameDate ? firstGameDate : today;
  const next_tues = getNextTuesday(targetDate); // the upcoming Tues which has yet to pass
  const last_tues = new Date(next_tues);
  last_tues.setDate(next_tues.getDate() - 7); // the most recent Tues, including targetDate if it is Tues

  const rankings = [];
  const tiebreaker = {
    away: '',
    home: '',
    ave_total: 0,
    commence: new Date(-8640000000000000),
  };

  // Filter for this week's games
  const filtered = data.filter(
    (game) => new Date(game.commence_time) >= last_tues && new Date(game.commence_time) < next_tues,
  );

  filtered.forEach((game) => {
    const home = game.home_team;
    const away = game.away_team;
    const commence = new Date(game.commence_time);
    const totals = [];
    const spreads = {};
    spreads[home] = [];
    spreads[away] = [];

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

    let ave_spread = spreads[home].reduce((a, b) => a + b, 0) / spreads[home].length;
    const ave_total = totals.reduce((a, b) => a + b, 0) / totals.length;

    // Check for tiebreaker game (total score for the last game of the week)
    if (commence > tiebreaker.commence) {
      tiebreaker.away = away;
      tiebreaker.home = home;
      tiebreaker.ave_total = ave_total;
      tiebreaker.commence = commence;
    }

    // Update the rankings list. Average spread is initialized as the average point spread for the home team
    let favorite = home;
    if (ave_spread > 0) {
      favorite = away;
      ave_spread *= -1;
    }
    rankings.push({ away, home, favorite, ave_spread, ave_total, commence });
  });

  // Sort the rankings and adjust names and number formatting
  const sortedRankings = rankings.sort((a, b) => a.ave_spread - b.ave_spread);
  sortedRankings.map((game) => {
    game.away = getCBSName(game.away);
    game.home = getCBSName(game.home);
    game.favorite = getCBSName(game.favorite);
    game.ave_spread = Math.round(game.ave_spread * 10) / 10;
    game.ave_total = Math.round(game.ave_total);
    return game;
  });

  tiebreaker.away = getCBSName(tiebreaker.away);
  tiebreaker.home = getCBSName(tiebreaker.home);
  tiebreaker.ave_total = Math.round(tiebreaker.ave_total);

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
  const daysUntilNextTuesday = ((8 - currentDay) % 7) + 1;
  const nextTuesday = new Date(date);
  nextTuesday.setDate(date.getDate() + daysUntilNextTuesday);
  return nextTuesday;
};

const getCBSName = (inputName) => {
  // Formats the inputName to match the team names on CBS Pick'Em site for better readability
  const cbs_names = {
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

  if (inputName in cbs_names) return cbs_names[inputName];

  console.error(`'${inputName}' does not exist in CBS name dictionary. Could not rename.`);
  return inputName;
};

export default getOddsData;
