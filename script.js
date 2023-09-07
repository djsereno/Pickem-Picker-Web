import getOddsData from './odds.js';

const params = new URLSearchParams(window.location.search);
const apiKey = params.get('apiKey');
const { sortedRankings, tiebreaker, usage } = await getOddsData(apiKey);

const body = document.querySelector('body');
const table = document.querySelector('table');

sortedRankings.forEach((game, index) => {
  const tableRow = document.createElement('tr');
  const rank = document.createElement('td');
  const awayTeam = document.createElement('td');
  const atSym = document.createElement('td');
  const homeTeam = document.createElement('td');
  const spread = document.createElement('td');
  const total = document.createElement('td');
  const gameTime = document.createElement('td');

  rank.classList.add('rank');
  awayTeam.classList.add('away');
  atSym.classList.add('at-symbol');
  homeTeam.classList.add('home');
  spread.classList.add('spread');
  total.classList.add('total');
  gameTime.classList.add('gametime');
  if (game.home === game.favorite) homeTeam.classList.add('favorite');
  if (game.away === game.favorite) awayTeam.classList.add('favorite');
  if (game.home === tiebreaker.home) {
    total.classList.add('tiebreaker');
    gameTime.classList.add('tiebreaker');
  }

  rank.innerText = 16 - index;
  awayTeam.innerText = game.away;
  atSym.innerText = '@';
  homeTeam.innerText = game.home;
  spread.innerText = game.ave_spread.toLocaleString('en-US', { minimumFractionDigits: 1 });
  total.innerText = game.ave_total;
  gameTime.innerText = `${game.commence.toDateString()} ${game.commence.toLocaleTimeString()}`;

  tableRow.appendChild(rank);
  tableRow.appendChild(awayTeam);
  tableRow.appendChild(atSym);
  tableRow.appendChild(homeTeam);
  tableRow.appendChild(spread);
  tableRow.appendChild(total);
  tableRow.appendChild(gameTime);
  table.appendChild(tableRow);
});

const used = 1;
const remaining = 1;

const infoNode = document.createElement('p');
infoNode.innerText = apiKey
  ? `API usage: ${usage.used} of ${usage.used + usage.remaining}`
  : '*** Sample data shown. For live data, provide your API key in the url as a query parameter (e.g. .../?apiKey=123XYZ) ***';
infoNode.classList.add('info');
body.appendChild(infoNode);
