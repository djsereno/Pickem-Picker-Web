import getSampleData from './sampledata.js';

const callOddsAPI = async () => {
  // An api key is emailed to you when you sign up to a plan (https://the-odds-api.com/)
  const API_KEY = '760acb50034976f9523bdfd557548c2c';

  try {
    const odds_response = await fetch(
      `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?` +
        new URLSearchParams({
          apiKey: API_KEY,
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
    console.log(JSON.stringify(data));
    console.log('Remaining requests', odds_response.headers.get('x-requests-remaining'));
    console.log('Used requests', odds_response.headers.get('x-requests-used'));
    return data;
  } catch (error) {
    console.error(error);
    return null;
  }
};

const getOddsData = async (useAPI = false) => {
  const oddsData = useAPI ? await callOddsAPI() : await getSampleData();
  if (!oddsData) return null;

  const today = new Date();
  const weekday = today.getDay() - 1;
  const next_tues = new Date().setDate(today.getDate() + ((7 - weekday) % 7) + 1);

  const rankings = [];
  const tiebreaker = {
    away: '',
    home: '',
    ave_total: 0,
    commence: new Date(-8640000000000000),
  };

  // Format to match CBS sports names for readability
  const cbs_names = {
    'Arizona Cardinals': 'Arizona',
    'Atlanta Falcons': 'Atlanta',
    'Baltimore Ravens': 'Baltimore',
    'Buffalo Bills': 'Buffalo',
    'Carolina Panthers': 'Carolina',
    'Chicago Bears': 'Chicago',
    'Cincinnati Bengals': 'Cincinnati',
    'Cleveland Browns': 'Cleveland',
    'Dallas Cowboys': 'Dallas',
    'Denver Broncos': 'Denver',
    'Detroit Lions': 'Detroit',
    'Green Bay Packers': 'Green Bay',
    'Houston Texans': 'Houston',
    'Indianapolis Colts': 'Indianapolis',
    'Jacksonville Jaguars': 'Jacksonville',
    'Kansas City Chiefs': 'Kansas City',
    'Las Vegas Raiders': 'Las Vegas',
    'Los Angeles Chargers': 'LA Chargers',
    'Los Angeles Rams': 'LA Rams',
    'Miami Dolphins': 'Miami',
    'Minnesota Vikings': 'Minnesota',
    'New England Patriots': 'New England',
    'New Orleans Saints': 'New Orleans',
    'New York Giants': 'New York (NYG)',
    'New York Jets': 'New York (NYJ)',
    'Philadelphia Eagles': 'Philadelphia',
    'Pittsburgh Steelers': 'Pittsburgh',
    'San Francisco 49ers': 'San Francisco',
    'Seattle Seahawks': 'Seattle',
    'Tampa Bay Buccaneers': 'Tampa Bay',
    'Tennessee Titans': 'Tennessee',
    'Washington Commanders': 'Washington',
  };

  // # Only include this week's games (games which commence before the upcoming Tuesday)
  const filtered = oddsData.filter((game) => new Date(game.commence_time) < next_tues);

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
    game.away = cbs_names[game.away];
    game.home = cbs_names[game.home];
    game.favorite = cbs_names[game.favorite];
    game.ave_spread = Math.floor(game.ave_spread * 10) / 10;
    game.ave_total = Math.floor(game.ave_total * 10) / 10;
    return game;
  });

  return sortedRankings;
};

export default getOddsData;
