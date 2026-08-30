import getOddsData, { getCoverProbability, buildRawOddsRows } from './odds.js';

// An api key is emailed to you when you sign up to a plan (https://the-odds-api.com/)
const params = new URLSearchParams(window.location.search);
const apiKey = params.get('apiKey');
const { sortedRankings, tiebreaker, usage, rawData, currentWeeksGames } = await getOddsData(apiKey);
const rawOddsRows = buildRawOddsRows(rawData, currentWeeksGames);

const body = document.querySelector('body');
const tableBody = document.querySelector('#table-body');
const slider = document.querySelector('#blend-slider');
const blendLabel = document.querySelector('#blend-label');
const rawTbody = document.querySelector('#raw-tbody');

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

// League format: straight-up ranks by P(favorite wins); ATS ranks by the favorite's cover
// probability vs the posted spread (via getCoverProbability), flipping to the underdog when
// the moneyline says the line is too big.
const LEAGUE_MODE_KEY = 'pickem-league-mode';
const DEFAULT_LEAGUE_MODE = 'straight';
let leagueMode = localStorage.getItem(LEAGUE_MODE_KEY);
if (leagueMode !== 'straight' && leagueMode !== 'ats') leagueMode = DEFAULT_LEAGUE_MODE;

// Per-game metric shown in the pick-% column and used as the sort key.
const computeGameDisplay = (game) => {
  if (leagueMode === 'ats') {
    // Moneyline only: the blended model+market is circular here because the spread-based
    // model derives its estimate from the line itself (modelProb = Φ(spread/σ)), so blending
    // it into the cover calc would drag every game toward 50%. The de-vigged moneyline is
    // the one signal independent of the spread.
    const favWinProb = game.marketProb ?? game.modelProb;
    const cover = getCoverProbability(favWinProb, Math.abs(game.aveSpread), game.aveTotal);
    const pickFav = cover >= 0.5;
    return {
      sortValue: pickFav ? cover : 1 - cover,
      pct: 100 * (pickFav ? cover : 1 - cover),
      pick: pickFav ? game.favorite : game.home === game.favorite ? game.away : game.home,
      isDog: !pickFav,
    };
  }
  const p = blendedProbability(game);
  return { sortValue: p, pct: 100 * p, pick: game.favorite, isDog: false };
};

const renderTable = () => {
  tableBody.innerHTML = ''; // atomic clear — replaces every data row before re-sorting/re-rendering
  const rows = [...sortedRankings]
    .map((game) => ({ game, disp: computeGameDisplay(game) }))
    .sort((a, b) => b.disp.sortValue - a.disp.sortValue);
  rows.forEach(({ game, disp }, index) => {
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
  if (disp.isDog) winProb.classList.add('dog');
  spread.classList.add('spread');
  total.classList.add('total');
  gameTime.classList.add('gametime');
  if (game.home === disp.pick) homeTeam.classList.add('favorite');
  if (game.away === disp.pick) awayTeam.classList.add('favorite');
  if (game.home === tiebreaker.home) {
    total.classList.add('tiebreaker');
    gameTime.classList.add('tiebreaker');
  }

  rank.innerText = 16 - index;
  awayTeam.innerText = game.away;
  atSym.innerText = '@';
  homeTeam.innerText = game.home;
  winProb.innerText = `${disp.pct.toFixed(1)}%${disp.isDog ? ' (dog)' : ''}`;
  const spreadSign = game.aveSpread > 0 ? '+' : '';
  spread.innerText = spreadSign + game.aveSpread.toLocaleString('en-US', { minimumFractionDigits: 1 });
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

const winPctHead = document.querySelector('#win-pct-head');
const updateHeaderLabel = () => {
  winPctHead.innerText = leagueMode === 'ats' ? 'Cover %' : 'Win %';
};
// League-format buttons: switch mode, persist, and re-render (all local math, no API calls)
const leagueButtons = document.querySelectorAll('.league-mode button');
leagueButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    leagueMode = btn.dataset.leagueMode;
    localStorage.setItem(LEAGUE_MODE_KEY, leagueMode);
    leagueButtons.forEach((b) => b.classList.toggle('active', b === btn));
    updateHeaderLabel();
    updateModeUI();
    renderTable();
  });
});
leagueButtons.forEach((b) => b.classList.toggle('active', b.dataset.leagueMode === leagueMode));
updateHeaderLabel();

// Mode-aware UI: show only the control/help bits that apply to the current league format.
// In ATS mode the blend slider is hidden — it mixes model+market, but the spread-based model
// can't judge covers independently of the line, so the moneyline is the only valid ATS input.
const updateModeUI = () => {
  document.querySelectorAll('[data-mode]').forEach((el) => {
    el.hidden = el.dataset.mode !== leagueMode;
  });
  const blendControls = document.querySelector('#blend-controls');
  if (blendControls) blendControls.hidden = leagueMode === 'ats';
};
updateModeUI();

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
helpButton.addEventListener('click', () => {
  updateModeUI();
  helpDialog.showModal();
});
helpDialog.querySelector('#help-close').addEventListener('click', () => helpDialog.close());
// Clicking the dimmed backdrop (outside the panel) also closes it
helpDialog.addEventListener('click', (event) => {
  if (event.target === helpDialog) helpDialog.close();
});

// Raw odds popout: per-bookmaker lines behind the averages, in a tabular view
const rawButton = document.querySelector('#raw-button');
const rawDialog = document.querySelector('#raw-dialog');
const RAW_DIALOG_CSS = {
  fav: 'raw-fav', // home team favored: negative spread / moneyline on the home side
  dog: 'raw-dog', // away team favored: positive spread / moneyline on the away side
};
if (rawTbody) {
  // Merge identical Game/Kickoff cells across each game's book rows via rowSpan,
  // so each game reads as one grouped block. This relies on rawOddsRows keeping
  // each game's rows contiguous (buildRawOddsRows emits them game by game).
  let gameTd = null;
  let kickTd = null;
  let prevGameLabel = null;
  for (const row of rawOddsRows) {
    const tr = document.createElement('tr');
    if (row.gameLabel === prevGameLabel && gameTd && kickTd) {
      gameTd.rowSpan += 1;
      kickTd.rowSpan += 1;
    } else {
      gameTd = document.createElement('td');
      // Fixed two-line layout: "Away @" on top, home team beneath (instead of
      // free-wrapping wherever the column happens to break)
      const awayDiv = document.createElement('div');
      awayDiv.innerText = `${row.awayTeam} @`;
      const homeDiv = document.createElement('div');
      homeDiv.innerText = row.homeTeam;
      gameTd.append(awayDiv, homeDiv);
      kickTd = document.createElement('td');
      const kickDate = document.createElement('div');
      kickDate.innerText = row.kickoffDate;
      const kickTime = document.createElement('div');
      kickTime.className = 'kick-time';
      kickTime.innerText = row.kickoffTime;
      kickTd.append(kickDate, kickTime);
      tr.appendChild(gameTd);
      tr.appendChild(kickTd);
      tr.classList.add('raw-game-start');
      prevGameLabel = row.gameLabel;
    }
    const bookTd = document.createElement('td');
    bookTd.innerText = row.bookmaker;
    tr.appendChild(bookTd);
    const spreadTd = document.createElement('td');
    spreadTd.innerText = row.spreadPoint === '' ? '—' : (row.spreadPoint > 0 ? `+${row.spreadPoint}` : `${row.spreadPoint}`);
    if (row.spreadPoint !== '') spreadTd.classList.add(row.spreadPoint > 0 ? RAW_DIALOG_CSS.dog : RAW_DIALOG_CSS.fav);
    tr.appendChild(spreadTd);
    const mlTd = document.createElement('td');
    // Show WHICH team the moneyline belongs to — a bare -179 could be either side.
    // Equal h2h prices mean a pick'em: no favorite, so label it as such.
    mlTd.innerText = row.favTeam ? `${row.favTeam} ${row.moneyline}` : row.moneyline ? `Pick'em ${row.moneyline}` : '—';
    if (row.favIsHome !== null) mlTd.classList.add(row.favIsHome ? RAW_DIALOG_CSS.fav : RAW_DIALOG_CSS.dog);
    tr.appendChild(mlTd);
    const totalTd = document.createElement('td');
    totalTd.innerText = row.total === '' ? '—' : row.total;
    tr.appendChild(totalTd);
    rawTbody.appendChild(tr);
  }
  const gameCount = new Set(rawOddsRows.map((r) => r.gameLabel)).size;
  const bookCount = new Set(rawOddsRows.map((r) => r.bookmaker)).size;
  document.querySelector('#raw-summary').innerText = `${gameCount} games · ${bookCount} books · ${rawOddsRows.length} lines`;
  rawButton.addEventListener('click', () => rawDialog.showModal());
  rawDialog.querySelector('#raw-close').addEventListener('click', () => rawDialog.close());
  // Clicking the dimmed backdrop (outside the panel) also closes it
  rawDialog.addEventListener('click', (event) => {
    if (event.target === rawDialog) rawDialog.close();
  });
}

const infoNode = document.createElement('p');
infoNode.innerText = usage
  ? `API usage: ${usage.used} of ${usage.used + usage.remaining}`
  : '*** Sample data shown. For live data, provide your API key in the url as a query parameter (i.e. https://djsereno.github.io/Pickem-Picker-Web/?apiKey=YOUR_API_KEY_HERE). ***';
infoNode.classList.add('info');
body.appendChild(infoNode);
