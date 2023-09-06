import json
import requests
from datetime import datetime, timedelta, time, timezone
import colorama

colorama.init()

# An api key is emailed to you when you sign up to a plan (https://the-odds-api.com/)
API_KEY = '760acb50034976f9523bdfd557548c2c'

# Format to match CBS sports names for readability
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
    'Washington Commanders': 'Washington'
}

# Get the current NFL spreads
odds_response = requests.get(f'https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds',
                             params={
                                 'api_key': API_KEY,
                                 'regions': 'us',
                                 'markets': 'spreads,totals',
                                 'oddsFormat': 'decimal',
                                 'dateFormat': 'iso',
                             })

if odds_response.status_code != 200:
    print(f'Failed to get odds: status_code {odds_response.status_code}, response body {odds_response.text}')

else:
    odds_json = odds_response.json()

    # Check the usage quota if successful
    print()
    print('Remaining requests', odds_response.headers['x-requests-remaining'])
    print('Used requests', odds_response.headers['x-requests-used'])

# # Save the json file for use while debugging to avoid counts towards quote usage
# odds_file = open('odds.json', 'w')
# json.dump(odds_json, odds_file, indent=6)
# odds_file.close()

# # Read locally saved json file for use while debugging to avoid counts towards quote usage
# with open('odds.json') as odds_file:
#     odds_content = odds_file.read()
# odds_json = json.loads(odds_content)

today = datetime.now()
weekday = datetime.weekday(today)
next_tues = datetime.combine(today.date() + timedelta((7 - weekday) % 7 + 1), time(0))

rankings = []
tiebreaker = {'away': '', 'home': '', 'ave_total': 0, 'commence': datetime.min}
for game in odds_json:
    commence = game['commence_time'].replace('Z', '')
    commence = datetime.fromisoformat(commence) - timedelta(hours=8)

    # Only include this week's games (games which commence before the upcoming Tuesday)
    if commence < next_tues:
        home = game['home_team']
        away = game['away_team']
        spreads = {home: [], away: []}
        totals = []

        # Get spreads and totals from each bookmaker
        for bookmaker in game['bookmakers']:
            title = bookmaker['title']
            for market in bookmaker['markets']:
                if market['key'] == 'spreads':
                    for team in market['outcomes']:
                        spreads[team['name']].append(team['point'])
                elif market['key'] == 'totals':
                    totals.append(market['outcomes'][0]['point'])

        ave_spread = sum(spreads[home]) / len(spreads[home])
        ave_total = sum(totals) / len(totals)

        # Check for tiebreaker game (total score for the last game of the week)
        if commence > tiebreaker['commence']:
            tiebreaker['away'] = away
            tiebreaker['home'] = home
            tiebreaker['ave_total'] = ave_total
            tiebreaker['commence'] = commence

        # Update the rankings list. Average spread is initialized as the average point spread for the home team
        if ave_spread < 0:
            favorite = home
        else:
            favorite = away
            ave_spread *= -1
        rankings.append([away, home, favorite, ave_spread, ave_total, commence])

# Rank games by spreads and display
print()
print('-' * 100)
print('RANK ' + ('AWAY TEAM').rjust(25) + ' @ ' + 'HOME TEAM'.ljust(25) + 'SPREAD'.rjust(7) + 'TOTAL'.rjust(7) + '   ' +
      'GAME TIME')
print('-' * 100)
sortedRankings = sorted(rankings, key=lambda x: x[3])
rank = 16
for game in sortedRankings:
    away = game[0]
    home = game[1]
    favorite = game[2]
    ave_spread = game[3]
    ave_total = game[4]
    commence = game[5]

    display = str(rank).ljust(4) + ' '
    if favorite == away:
        display += colorama.Fore.WHITE + colorama.Back.BLUE + colorama.Style.BRIGHT + (cbs_names[away]).rjust(25)
        display += colorama.Fore.RESET + colorama.Back.RESET + colorama.Style.NORMAL + ' @ ' + cbs_names[home].ljust(25)
    else:
        display += cbs_names[away].rjust(25) + ' @ '
        display += colorama.Fore.WHITE + colorama.Back.BLUE + colorama.Style.BRIGHT + (cbs_names[home]).ljust(25)
        display += colorama.Fore.RESET + colorama.Back.RESET + colorama.Style.NORMAL
    display += '{:.1f}'.format(ave_spread).rjust(7)
    display += '{:.0f}'.format(ave_total).rjust(7) + '   '
    display += commence.strftime('%a %m-%d-%Y %I:%M %p')
    print(display)

    rank -= 1

print('-' * 100)
print()
print('MNF TIEBREAKER: ', '{:.0f}'.format(tiebreaker['ave_total']), '  ', cbs_names[tiebreaker['away']], ' @ ',
      cbs_names[tiebreaker['home']], '  ', tiebreaker['commence'].strftime('%a %m-%d-%Y %I:%M %p'))
print()