import getOddsData from './odds.js';

// An api key is emailed to you when you sign up to a plan (https://the-odds-api.com/)
const params = new URLSearchParams(window.location.search);
const apiKey = params.get('apiKey');
const { sortedRankings, tiebreaker, usage } = await getOddsData(apiKey);

const body = document.querySelector('body');
const tableBody = document.querySelector('#table-body');
const slider = document.querySelector('#blend-slider');
const blendLabel = document.querySelector('#blend-label');

// Slider position: % weight on the spread+total model vs de-vigged moneylines.
// Re-blending is pure local arithmetic on the stored components -> no extra API calls.
// The slider's natural axis is Model(left) :: Market(right), so the raw slider value is
// the MARKET share and modelPercent is its complement.
const WEIGHT_STORAGE_KEY = 'pickem-model-weight';
const DEFAULT_WEIGHT_PERCENT = 50;

// NB: Number(null) === 0, so an absent saved value must be checked explicitly
// or every first-time visitor would start at 0% instead of the 50% default.
const storedWeight = localStorage.getItem(WEIGHT_STORAGE_KEY);
let weightPercent =
  storedWeight === null || !Number.isFinite(+storedWeight) || +storedWeight < 0 || +storedWeight > 100
    ? DEFAULT_WEIGHT_PERCENT
    : Number(storedWeight);

// Games without moneyline data always use the pure model, whatever the slider says
const blendedProbability = (game) =>
  game.marketProb == null
    ? game.modelProb
    : (weightPercent / 100) * game.modelProb + (1 - weightPercent / 100) * game.marketProb;

const renderTable = () => {
  tableBody.innerHTML = ''; // atomic clear — replaces every data row before re-sorting/re-rendering
  [...sortedRankings].sort((a, b) => blendedProbability(b) - blendedProbability(a)).forEach((game, index) => {
  const tableRow = document.createElement('tr');
  const rank = document.createElement('td');
  const awayTeam = document.createElement('td');
  const atSym = document.createElement('td');
  const homeTeam = document.createElement('td');
  const winProb = document.createElement('td');
  const spread = document.createElement('td');
  const total = document.createElement('td');
  const gameTime = document.createElement('td');

  rank.classList.add('rank');
  awayTeam.classList.add('away');
  atSym.classList.add('at-symbol');
  homeTeam.classList.add('home');
  winProb.classList.add('win-prob');
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
  winProb.innerText = `${Math.round(blendedProbability(game) * 100)}%`;
  spread.innerText = game.aveSpread.toLocaleString('en-US', { minimumFractionDigits: 1 });
  total.innerText = game.aveTotal;
  gameTime.innerText = `${game.commence.toLocaleDateString('en-us', {
    weekday: 'long',
    month: 'numeric',
    day: 'numeric',
  })} @ ${game.commence.toLocaleTimeString('en-us', {
    hour: 'numeric',
    minute: 'numeric',
  })}`;

  tableRow.appendChild(rank);
  tableRow.appendChild(awayTeam);
  tableRow.appendChild(atSym);
  tableRow.appendChild(homeTeam);
  tableRow.appendChild(winProb);
  tableRow.appendChild(spread);
  tableRow.appendChild(total);
  tableRow.appendChild(gameTime);
  tableBody.appendChild(tableRow);
  });
};

slider.value = String(100 - weightPercent);
const updateBlendLabel = () => {
  blendLabel.innerText = `Model ${weightPercent}% ⟷ Market ${100 - weightPercent}%`;
};
slider.addEventListener('input', () => {
  weightPercent = 100 - Number(slider.value);
  localStorage.setItem(WEIGHT_STORAGE_KEY, String(weightPercent));
  updateBlendLabel();
  renderTable();
});

// Preset buttons (Model / 50-50 / Market) snap the slider to a fixed blend
document.querySelectorAll('.controls-axis button').forEach((btn) => {
  btn.addEventListener('click', () => {
    weightPercent = Number(btn.dataset.modelPercent);
    slider.value = String(100 - weightPercent);
    localStorage.setItem(WEIGHT_STORAGE_KEY, String(weightPercent));
    updateBlendLabel();
    renderTable();
  });
});

updateBlendLabel();
renderTable();

// Help dialog: native <dialog> gives us Esc-to-close and focus handling for free
const helpButton = document.querySelector('#help-button');
const helpDialog = document.querySelector('#help-dialog');
helpButton.addEventListener('click', () => helpDialog.showModal());
helpDialog.querySelector('#help-close').addEventListener('click', () => helpDialog.close());
// Clicking the dimmed backdrop (outside the panel) also closes it
helpDialog.addEventListener('click', (event) => {
  if (event.target === helpDialog) helpDialog.close();
});

const infoNode = document.createElement('p');
infoNode.innerText = usage
  ? `API usage: ${usage.used} of ${usage.used + usage.remaining}`
  : '*** Sample data shown. For live data, provide your API key in the url as a query parameter (i.e. https://djsereno.github.io/Pickem-Picker-Web/?apiKey=YOUR_API_KEY_HERE). ***';
infoNode.classList.add('info');
body.appendChild(infoNode);
