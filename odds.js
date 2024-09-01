import getSampleData from './sampledata.js';

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
    const aveTotal = totals.reduce((a, b) => a + b, 0) / totals.length;

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
    rankings.push({ away, home, favorite, aveSpread, aveTotal, commence });
  });

  // Sort the rankings and adjust names and number formatting
  const sortedRankings = rankings.sort((a, b) => a.aveSpread - b.aveSpread);
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
