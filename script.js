// An api key is emailed to you when you sign up to a plan (https://the-odds-api.com/)
const API_KEY = '760acb50034976f9523bdfd557548c2c';

// Format to match CBS sports names for readability
cbs_names = {
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

const odds_response = requests.get(`https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds`, {
  params: {
    api_key: API_KEY,
    regions: 'us',
    markets: 'spreads,totals',
    oddsFormat: 'decimal',
    dateFormat: 'iso',
  },
});

if (odds_response.status_code !== 200) {
  console.log(`Failed to get odds: status_code ${odds_response.status_code}, response body ${odds_response.text}`);
} else {
  odds_json = odds_response.json();
  console.log();
  console.log('Remaining requests', odds_response.headers['x-requests-remaining']);
  console.log('Used requests', odds_response.headers['x-requests-used']);
}

today = datetime.now();
weekday = datetime.weekday(today);
next_tues = datetime.combine(today.date() + timedelta(((7 - weekday) % 7) + 1), time(0));
rankings = [];
tiebreaker = {
  away: '',
  home: '',
  ave_total: 0,
  commence: datetime.min,
};

for (var game, _pj_c = 0, _pj_a = odds_json, _pj_b = _pj_a.length; _pj_c < _pj_b; _pj_c += 1) {
  game = _pj_a[_pj_c];
  commence = game['commence_time'].replace('Z', '');
  commence =
    datetime.fromisoformat(commence) -
    timedelta({
      hours: 8,
    });

  if (commence < next_tues) {
    home = game['home_team'];
    away = game['away_team'];
    spreads = {
      [home]: [],
      [away]: [],
    };
    totals = [];

    for (var bookmaker, _pj_f = 0, _pj_d = game['bookmakers'], _pj_e = _pj_d.length; _pj_f < _pj_e; _pj_f += 1) {
      bookmaker = _pj_d[_pj_f];
      title = bookmaker['title'];

      for (var market, _pj_i = 0, _pj_g = bookmaker['markets'], _pj_h = _pj_g.length; _pj_i < _pj_h; _pj_i += 1) {
        market = _pj_g[_pj_i];

        if (market['key'] === 'spreads') {
          for (var team, _pj_l = 0, _pj_j = market['outcomes'], _pj_k = _pj_j.length; _pj_l < _pj_k; _pj_l += 1) {
            team = _pj_j[_pj_l];
            spreads[team['name']].append(team['point']);
          }
        } else {
          if (market['key'] === 'totals') {
            totals.append(market['outcomes'][0]['point']);
          }
        }
      }
    }

    ave_spread = sum(spreads[home]) / spreads[home].length;
    ave_total = sum(totals) / totals.length;

    if (commence > tiebreaker['commence']) {
      tiebreaker['away'] = away;
      tiebreaker['home'] = home;
      tiebreaker['ave_total'] = ave_total;
      tiebreaker['commence'] = commence;
    }

    if (ave_spread < 0) {
      favorite = home;
    } else {
      favorite = away;
      ave_spread *= -1;
    }

    rankings.append([away, home, favorite, ave_spread, ave_total, commence]);
  }
}

console.log();
console.log('-' * 100);
console.log(
  'RANK ' +
    'AWAY TEAM'.rjust(25) +
    ' @ ' +
    'HOME TEAM'.ljust(25) +
    'SPREAD'.rjust(7) +
    'TOTAL'.rjust(7) +
    '   ' +
    'GAME TIME',
);
console.log('-' * 100);
sortedRankings = sorted(rankings, {
  key: (x) => {
    return x[3];
  },
});
rank = 16;

for (var game, _pj_c = 0, _pj_a = sortedRankings, _pj_b = _pj_a.length; _pj_c < _pj_b; _pj_c += 1) {
  game = _pj_a[_pj_c];
  away = game[0];
  home = game[1];
  favorite = game[2];
  ave_spread = game[3];
  ave_total = game[4];
  commence = game[5];
  display = rank.toString().ljust(4) + ' ';

  if (favorite === away) {
    display += colorama.Fore.WHITE + colorama.Back.BLUE + colorama.Style.BRIGHT + cbs_names[away].rjust(25);
    display += colorama.Fore.RESET + colorama.Back.RESET + colorama.Style.NORMAL + ' @ ' + cbs_names[home].ljust(25);
  } else {
    display += cbs_names[away].rjust(25) + ' @ ';
    display += colorama.Fore.WHITE + colorama.Back.BLUE + colorama.Style.BRIGHT + cbs_names[home].ljust(25);
    display += colorama.Fore.RESET + colorama.Back.RESET + colorama.Style.NORMAL;
  }

  display += '{:.1f}'.format(ave_spread).rjust(7);
  display += '{:.0f}'.format(ave_total).rjust(7) + '   ';
  display += commence.strftime('%a %m-%d-%Y %I:%M %p');
  console.log(display);
  rank -= 1;
}

console.log('-' * 100);
console.log();
console.log(
  'MNF TIEBREAKER: ',
  '{:.0f}'.format(tiebreaker['ave_total']),
  '  ',
  cbs_names[tiebreaker['away']],
  ' @ ',
  cbs_names[tiebreaker['home']],
  '  ',
  tiebreaker['commence'].strftime('%a %m-%d-%Y %I:%M %p'),
);
console.log();
