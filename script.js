import getOddsData, { getCoverProbability, buildRawOddsRows } from './odds.js';
import getSampleData from './sampledata.js';
import { TEAMS, TEAM_ABBREVIATIONS, buildSchedule, buildForecasts, createPool, currentWeek, leverageAdvice, survivalAdvice, validateEntry } from './survivor.js';

// An api key is emailed to you when you sign up to a plan (https://the-odds-api.com/)
const params = new URLSearchParams(window.location.search);
const apiKey = params.get('apiKey');
const { sortedRankings, tiebreaker, usage, rawData, currentWeeksGames } = await getOddsData(apiKey);
const rawOddsRows = buildRawOddsRows(rawData, currentWeeksGames);
// sample-data.json is our bundled yearly schedule fixture even when live odds are
// being used. Add winner/tied fields there as results become final.
const seasonFixture = await getSampleData();
const seasonSchedule = buildSchedule(seasonFixture.data.length ? seasonFixture.data : rawData);

// Optional test harness (?sim=1, only when no live API key): lets you advance the sample
// season by marking games complete, so locking/eliminations/advice can be previewed. Results
// live only in memory — a module-level map applied onto the schedule at each render.
const simEnabled = params.get('sim') === '1' && !apiKey;
const simResults = new Map(); // `${away}|${home}` -> { winner } | { tied }
const simKey = (game) => `${game.away}|${game.home}`;
const simByKey = new Map(sortedRankings.map((game) => [simKey(game), game]));
const simFavorite = (game) => simByKey.get(simKey(game))?.favorite || game.home; // moneyline favorite; Elo-home fallback
const simApply = () => {
  for (const [key, result] of simResults) {
    const game = seasonSchedule.find((candidate) => simKey(candidate) === key);
    if (!game) continue;
    game.winner = result.tied ? null : (result.winner || game.home);
    game.tied = !!result.tied;
  }
};
const simClear = () => {
  for (const key of simResults.keys()) {
    const game = seasonSchedule.find((candidate) => simKey(candidate) === key);
    if (game) { delete game.winner; delete game.tied; }
  }
  simResults.clear();
};
const simCompleteWeek = (week) => {
  for (const game of seasonSchedule) {
    if (game.week === week && !game.winner && !game.tied) simResults.set(simKey(game), { winner: simFavorite(game) });
  }
};
const simCompleteThrough = (through) => { for (let week = 1; week <= through; week += 1) simCompleteWeek(week); };

const body = document.querySelector('body');
const tableBody = document.querySelector('#table-body');
const slider = document.querySelector('#blend-slider');
const blendLabel = document.querySelector('#blend-label');
const rawTbody = document.querySelector('#raw-tbody');
const survivorPanel = document.querySelector('#survivor-panel');
const allPickBoard = document.querySelector('#all-pick-board');
const pickLegend = document.querySelector('#pick-legend');
const legendSamples = document.querySelector('#legend-samples');
const poolSummary = document.querySelector('#pool-summary');
const survivorAdvice = document.querySelector('#survivor-advice');
const publicBehavior = document.querySelector('#public-behavior');
const addEntryButton = document.querySelector('#add-entry');
const importPoolFile = document.querySelector('#import-pool-file');
const weekTabs = document.querySelector('#week-tabs');
const weeklyPickRows = document.querySelector('#weekly-pick-rows');
const weeklyPickHelp = document.querySelector('#weekly-pick-help');
const weeklyPickActions = document.querySelector('#weekly-pick-actions');
const poolActionsGroup = document.querySelector('#pool-actions-group');
const renameAllButton = document.querySelector('#rename-all');
const clearWeekButton = document.querySelector('#clear-week');
let allNamesEditing = false;
const renamingRows = new Set();
const committedRows = new Set();
let correctionsActive = false; // Make corrections toggle (like Rename all)
const clearWeekFutureButton = document.querySelector('#clear-week-future');
const makeCorrectionsButton = document.querySelector('#make-corrections');
const simPanel = document.querySelector('#sim-panel');
const simCurrentWeekButton = document.querySelector('#sim-current-week');
const simWeeksButton = document.querySelector('#sim-weeks');
const simWeeksInput = document.querySelector('#sim-weeks-n');
const simFullSeasonButton = document.querySelector('#sim-full-season');
const simClearButton = document.querySelector('#sim-clear');
const openSimulatorButton = document.querySelector('#open-simulator');
const rankHead = document.querySelector('#rank-head');
const POOL_STORAGE_KEY = 'pickem-survivor-pool-v1';
let pool;
try { pool = JSON.parse(localStorage.getItem(POOL_STORAGE_KEY)) || createPool(); } catch { pool = createPool(); }
if (!pool || pool.version !== 1 || !Array.isArray(pool.entries)) pool = createPool();
// Migrate existing pools: the previously selected entry becomes the fixed first row.
if (pool.myEntryId) {
  const selectedIndex = pool.entries.findIndex((entry) => entry.id === pool.myEntryId);
  if (selectedIndex > 0) pool.entries.unshift(pool.entries.splice(selectedIndex, 1)[0]);
}
pool.myEntryId = pool.entries[0]?.id || '';
// Simulator sandbox: work on a throwaway copy of the real pool. Nothing done under
// ?sim=1 is ever written back — each sim visit starts as a fresh copy of the real pool.
if (simEnabled) pool = JSON.parse(JSON.stringify(pool));
const savePool = () => { if (!simEnabled) localStorage.setItem(POOL_STORAGE_KEY, JSON.stringify(pool)); };

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
if (!['straight', 'ats', 'survivor'].includes(leagueMode)) leagueMode = DEFAULT_LEAGUE_MODE;

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
  if (leagueMode === 'survivor') {
    const mine = pool.entries.find((entry) => entry.id === pool.myEntryId);
    const used = mine ? validateEntry(mine, seasonSchedule).used : new Set();
    const favoriteProbability = blendedProbability(game);
    const candidates = [
      !used.has(game.home) && { team: game.home, probability: game.favorite === game.home ? favoriteProbability : 1 - favoriteProbability },
      !used.has(game.away) && { team: game.away, probability: game.favorite === game.away ? favoriteProbability : 1 - favoriteProbability },
    ].filter(Boolean);
    const candidate = candidates.sort((a, b) => b.probability - a.probability)[0];
    if (!candidate) return null;
    return { sortValue: candidate.probability, pct: 100 * candidate.probability, pick: candidate.team, isDog: candidate.team !== game.favorite };
  }
  const p = blendedProbability(game);
  return { sortValue: p, pct: 100 * p, pick: game.favorite, isDog: false };
};

const renderTable = () => {
  tableBody.innerHTML = ''; // atomic clear — replaces every data row before re-sorting/re-rendering
  const rows = [...sortedRankings]
    .map((game) => ({ game, disp: computeGameDisplay(game) }))
    .filter(({ disp }) => disp)
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
  if (leagueMode !== 'survivor' && game.home === tiebreaker.home) {
    total.classList.add('tiebreaker');
    gameTime.classList.add('tiebreaker');
  }

  rank.innerText = leagueMode === 'survivor' ? index + 1 : 16 - index;
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
  winPctHead.innerText = leagueMode === 'ats' ? 'Cover %' : leagueMode === 'survivor' ? 'Survival %' : 'Win %';
  rankHead.innerText = leagueMode === 'survivor' ? 'Choice' : 'Rank';
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
    renderSurvivor();
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
  survivorPanel.hidden = leagueMode !== 'survivor';
};

const completedWeek = () => Math.max(0, ...seasonSchedule.filter((game) => game.winner || game.tied).map((game) => game.week));
const entryId = () => globalThis.crypto?.randomUUID?.() || `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const forecastSeason = () => buildForecasts(seasonSchedule, sortedRankings, blendedProbability);
const myEntry = () => pool.entries[0];
let currentBoardWeek = null;


const renderPickLegend = () => {
  legendSamples.innerHTML = '';
  const samples = [
    { abbr: 'BUF', className: '', label: 'Pickable', disabled: false },
    { abbr: 'BUF', className: 'selected', label: "Week's pick", disabled: false },
    { abbr: 'BUF', className: 'bye', label: 'On bye', disabled: true },
    { abbr: 'BUF', className: 'used', label: 'Already used', disabled: true },
  ];
  for (const sample of samples) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.tabIndex = -1;
    badge.disabled = sample.disabled;
    badge.className = `team-pick ${sample.className}`.trim();
    badge.setAttribute('aria-hidden', 'true');
    badge.innerText = sample.abbr;
    const label = document.createElement('span');
    label.className = 'legend-label';
    label.innerText = sample.label;
    item.append(badge, label);
    legendSamples.appendChild(item);
  }
  pickLegend.hidden = false;
};

const renderWeeklyPickBoard = (schedule, statuses, done, defaultWeek, simCurrentWeek = 0) => {
  const chosen = pool.pickWeek === 'all' ? 'all' : Number(pool.pickWeek);
  const week = chosen === 'all' || (Number.isInteger(chosen) && chosen >= 1 && chosen <= 18) ? chosen : defaultWeek;
  pool.pickWeek = week;
  weekTabs.innerHTML = '';
  const addTab = (label, value, controls, title, locked = false) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'week-tab';
    if (value === 'all') tab.classList.add('all');
    tab.dataset.week = value;
    tab.role = 'tab';
    tab.setAttribute('aria-selected', value === week);
    tab.setAttribute('aria-controls', controls);
    tab.innerText = label;
    tab.title = title;
    tab.classList.toggle('active', value === week);
    tab.classList.toggle('locked', locked);
    tab.classList.toggle('current', simCurrentWeek > 0 && value === simCurrentWeek);
    weekTabs.appendChild(tab);
  };
  addTab('All', 'all', 'all-pick-board', 'Review every selection from W1 through W18 at once.');
  for (let number = 1; number <= 18; number += 1) {
    addTab(`W${number}`, number, 'weekly-pick-rows', `Week ${number}${number <= done ? ' (completed - locked)' : ''}${number === simCurrentWeek ? ' — current week in simulation' : ''}`, number <= done);
  }
  const showingAll = week === 'all';
  renderPickLegend();
  allPickBoard.hidden = !showingAll;
  weeklyPickRows.hidden = showingAll;
  if (showingAll) {
    weeklyPickHelp.innerText = 'Every week at once. Completed weeks are locked; use the Make corrections button on a week tab to unlock them.';
    weeklyPickActions.hidden = false;
    poolActionsGroup.hidden = false;
    currentBoardWeek = null;
    clearWeekButton.hidden = true;
    clearWeekFutureButton.hidden = true;
    makeCorrectionsButton.hidden = true;
    renderAllBoard(statuses, done);
    return;
  }
  currentBoardWeek = week;
  const teamsPlaying = new Set(schedule.filter((game) => game.week === week).flatMap((game) => [game.home, game.away]));
  const locked = week <= done;
  weeklyPickActions.hidden = false;
  poolActionsGroup.hidden = true;
  clearWeekButton.hidden = false;
  clearWeekFutureButton.hidden = false;
  clearWeekButton.disabled = locked;
  clearWeekFutureButton.disabled = locked;
  makeCorrectionsButton.hidden = !locked;
  makeCorrectionsButton.innerText = correctionsActive ? 'Save changes' : 'Make corrections';
  makeCorrectionsButton.classList.toggle('primary', correctionsActive);
  makeCorrectionsButton.title = correctionsActive
    ? 'Save all edit changes for this week and return it to locked.'
    : `Unlock Week ${week} so every entry's pick (including eliminated entries) can be changed.`;
  const clearLockHint = 'This completed week is locked; use Make corrections to change picks.'
  clearWeekButton.title = locked ? clearLockHint : `Clear every entry's pick for Week ${week}`;
  clearWeekFutureButton.title = locked ? clearLockHint : `Clear every entry's pick for Week ${week} and all later weeks`;
  if (correctionsActive) weeklyPickHelp.innerText = 'Corrections enabled — change any pick below, then click Save changes to re-lock the week.';
  else weeklyPickHelp.innerText = locked
    ? 'This completed week is locked. Use Make corrections to change an entry.'
    : 'Choose one eligible team for each active entry.';
  weeklyPickRows.innerHTML = '';
  // Status as of the viewed week: an entry eliminated in a later week still shows Active here.
  const weekStatuses = new Map(pool.entries.map((entry) => [entry.id, validateEntry(entry, schedule, done, week)]));
  const head = document.createElement('div'); head.className = 'weekly-pick-head';
  const headName = document.createElement('div'); headName.className = 'all-head-name'; headName.innerText = 'Name'; head.appendChild(headName);
  const headStatus = document.createElement('div'); headStatus.className = 'weekly-status-heading'; headStatus.innerText = 'Status'; head.appendChild(headStatus);
  const headWeek = document.createElement('div'); headWeek.className = 'weekly-week-heading'; headWeek.innerText = `Week ${week}`; head.appendChild(headWeek);
  weeklyPickRows.appendChild(head);
  for (const entry of pool.entries) {
    const status = statuses.get(entry.id); // season-wide: drives the used-team graying
    const weekStatus = weekStatuses.get(entry.id); // as of the viewed week: drives display
    const row = document.createElement('div'); row.className = 'weekly-pick-row';
    if (entry === myEntry()) row.classList.add('my-entry');
    if (weekStatus.status === 'Invalid history' || (weekStatus.status === 'Eliminated' && status.eliminatedWeek !== null && week > status.eliminatedWeek)) row.classList.add('eliminated-row');
    if (correctionsActive) { row.classList.remove('eliminated-row'); row.classList.add('corrections-row'); }
    const name = document.createElement('div'); name.className = 'weekly-pick-name'; name.innerText = entry === myEntry() ? entry.name || 'My entry' : entry.name || 'Opponent';
    if (weekStatus.status === 'Eliminated') name.classList.add('eliminated-name');
    row.appendChild(name);
const statusCell = document.createElement('div'); statusCell.className = `week-status status-${weekStatus.status.toLowerCase().replaceAll(' ', '-')}`;
    statusCell.innerHTML = weekStatus.status === 'Active' ? '<i class="fa-solid fa-check" aria-hidden="true"></i>' : (weekStatus.status === 'Eliminated' ? '<i class="fa-solid fa-xmark" aria-hidden="true"></i>' : '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>');
    statusCell.title = weekStatus.status + (weekStatus.errors.length ? ` — ${weekStatus.errors[0]}` : '');
    row.appendChild(statusCell);
    const buttons = document.createElement('div'); buttons.className = 'team-buttons';
    const currentPick = entry.picks?.[week] || '';
    const usedElsewhere = new Set(status.used); usedElsewhere.delete(currentPick);
    for (const team of TEAMS) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'team-pick'; button.innerText = TEAM_ABBREVIATIONS[team]; button.title = team; button.setAttribute('aria-label', team);
      const selected = team === currentPick; button.classList.toggle('selected', selected);
      const editable = correctionsActive || !locked;
      const isEliminated = weekStatus.status !== 'Active';
      const onBye = !teamsPlaying.has(team);
      const alreadyUsed = !selected && usedElsewhere.has(team);
      // Bye styling is moot on eliminated rows: the entry can't pick anyone, so every
      // pill renders as plain disabled gray instead of the dashed bye look. During a
      // corrections session the row is editable again and bye styling still applies.
      button.classList.toggle('bye', onBye && !alreadyUsed && !(isEliminated && !correctionsActive));
      button.classList.toggle('used', alreadyUsed);
      // Bye teams are never valid picks (no game that week); used teams and eliminated
      // rows only unlock while a corrections session is active for this week.
      button.disabled = onBye || (!correctionsActive && (isEliminated || !editable || alreadyUsed));
      if (!correctionsActive && isEliminated) button.title = `${team} — ${weekStatus.status}`;
      else if (onBye) button.title = `${team} — on bye this week`;
      else if (!correctionsActive && alreadyUsed) button.title = `${team} — already used in a previous week`;
      else if (!editable) button.title = `${team} — this week is locked`;
      if (selected && locked) {
        const game = schedule.find((candidate) => candidate.week === week && (candidate.home === team || candidate.away === team));
        if (game && (game.winner || game.tied)) {
          const outcome = game.tied ? 'tied' : game.winner === team ? 'won' : 'lost';
          button.classList.add(outcome === 'won' ? 'pick-correct' : 'pick-incorrect');
          // Outside a corrections session the week is locked: use the subtler
          // locked tint instead of the vivid edit-mode hue.
          if (!correctionsActive) button.classList.add('locked');
          button.title = `${team} — ${outcome}`;
        }
      }
      button.addEventListener('click', () => { entry.picks ||= {}; if (selected) delete entry.picks[week]; else entry.picks[week] = team; savePool(); renderSurvivor(); renderTable(); });
      buttons.appendChild(button);
    }
    row.appendChild(buttons); weeklyPickRows.appendChild(row);
  }
  // Eliminated rows stay on the board (dimmed after their exit week), so the empty
  // state only applies when the pool genuinely has no entries to render.
  if (!pool.entries.length && !correctionsActive) weeklyPickRows.innerText = 'No active entries are available for team selection.';
};

const renderAllBoard = (statuses, done) => {
  allPickBoard.innerHTML = '';
  renameAllButton.innerText = allNamesEditing ? 'Save names' : 'Rename all';
  renameAllButton.classList.toggle('primary', allNamesEditing);
  const head = document.createElement('div'); head.className = 'all-pick-head';
  const headName = document.createElement('div'); headName.className = 'all-head-name'; headName.innerText = 'Name'; head.appendChild(headName);
  const headStatus = document.createElement('div'); headStatus.className = 'weekly-status-heading'; headStatus.innerText = 'Status'; head.appendChild(headStatus);
  const headBar = document.createElement('div'); headBar.className = 'all-pick-bar';
  for (let number = 1; number <= 18; number += 1) {
    const label = document.createElement('span'); label.className = 'all-week-label'; label.innerText = `W${number}`; headBar.appendChild(label);
  }
  head.appendChild(headBar);
  const headControls = document.createElement('div'); headControls.className = 'all-pick-controls'; head.appendChild(headControls);
  allPickBoard.appendChild(head);
  for (const [entryIndex, entry] of pool.entries.entries()) {
    const status = statuses.get(entry.id);
    const row = document.createElement('div'); row.className = 'all-pick-row';
    if (entryIndex === 0) row.classList.add('my-entry');
    const meta = document.createElement('div'); meta.className = 'all-pick-meta';
    const editing = renamingRows.has(entry.id) || (allNamesEditing && !committedRows.has(entry.id));
    const name = document.createElement('div'); name.className = 'weekly-pick-name'; if (status.status === 'Eliminated') name.classList.add('eliminated-name');
    if (editing) {
      const input = document.createElement('input'); input.type = 'text'; input.className = 'name-input'; input.value = entry.name || ''; input.placeholder = entryIndex === 0 ? 'My entry' : 'Opponent'; input.dataset.entryId = entry.id;
      input.addEventListener('change', () => { entry.name = input.value.trim(); savePool(); });
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        entry.name = input.value.trim();
        if (allNamesEditing) committedRows.add(entry.id);
        renamingRows.delete(entry.id);
        savePool();
        if (allNamesEditing && pool.entries.every((candidate) => committedRows.has(candidate.id))) {
          allNamesEditing = false;
          committedRows.clear();
        }
        const ids = pool.entries.map((candidate) => candidate.id);
        const nextId = allNamesEditing ? (ids.slice(ids.indexOf(entry.id) + 1).find((id) => !committedRows.has(id)) || '') : '';
        renderSurvivor();
        if (nextId) { const target = allPickBoard.querySelector(`input[data-entry-id="${nextId}"]`); if (target) { target.focus(); target.select(); } }
      });
      name.appendChild(input);
    } else {
      name.innerText = entryIndex === 0 ? entry.name || 'My entry' : entry.name || 'Opponent';
    }
    meta.appendChild(name);
    row.appendChild(meta);
    const statusCell = document.createElement('div'); statusCell.className = `week-status status-${status.status.toLowerCase().replaceAll(' ', '-')}`;
    statusCell.innerHTML = status.status === 'Active' ? '<i class="fa-solid fa-check" aria-hidden="true"></i>' : (status.status === 'Eliminated' ? '<i class="fa-solid fa-xmark" aria-hidden="true"></i>' : '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>');
    statusCell.title = status.status + (status.errors.length ? ` — ${status.errors[0]}` : '');
    row.appendChild(statusCell);
    const bar = document.createElement('div'); bar.className = 'all-pick-bar';
    for (let number = 1; number <= 18; number += 1) {
      const picked = entry.picks?.[number];
      if (picked) {
        const pill = document.createElement('span'); pill.className = 'pick-pill'; pill.innerText = TEAM_ABBREVIATIONS[picked] || picked; pill.title = picked;
        const locked = number <= done;
        pill.classList.toggle('locked', locked);
        if (locked) {
          const game = seasonSchedule.find((candidate) => candidate.week === number && (candidate.home === picked || candidate.away === picked));
          if (game && (game.winner || game.tied)) {
            const outcome = game.tied ? 'tied' : game.winner === picked ? 'won' : 'lost';
            pill.classList.add(outcome === 'won' ? 'pick-correct' : 'pick-incorrect');
            pill.title = `${picked} — ${outcome}`;
          }
        }
        bar.appendChild(pill);
      } else {
        const empty = document.createElement('span'); empty.className = 'pick-empty'; empty.innerText = '—'; bar.appendChild(empty);
      }
    }
    row.appendChild(bar);
    const controls = document.createElement('div'); controls.className = 'all-pick-controls';
    if (entryIndex > 0) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.innerText = 'Remove'; remove.className = 'danger'; remove.addEventListener('click', () => { if (!confirm(`Remove ${entry.name || 'this opponent'}?`)) return; pool.entries = pool.entries.filter((candidate) => candidate.id !== entry.id); savePool(); renderSurvivor(); renderTable(); }); controls.appendChild(remove);
    }
    const rename = document.createElement('button'); rename.type = 'button'; rename.innerText = editing ? 'Save name' : 'Rename'; rename.classList.toggle('primary', editing);
    rename.addEventListener('click', () => { if (editing) { const input = name.querySelector('input'); if (input) entry.name = input.value.trim(); renamingRows.delete(entry.id); savePool(); } else { renamingRows.add(entry.id); } renderSurvivor(); if (!editing) { const input = allPickBoard.querySelector(`input[data-entry-id="${entry.id}"]`); if (input) { input.focus(); input.select(); } } });
    controls.appendChild(rename);
    row.appendChild(controls); allPickBoard.appendChild(row);
  }
};
// Rendering pool data is cheap. The expensive 10,000-run simulation deliberately
// happens only when the user asks for a fresh calculation.
const renderSurvivor = (calculate = false) => {
  if (!survivorPanel || leagueMode !== 'survivor') return;
  if (simEnabled) simApply(); // test harness: fold simulated results into the schedule before any reads
  simPanel.hidden = !simEnabled;
  // The Simulator shortcut only makes sense outside sim mode, and the harness itself is
  // gated on no live API key — don't advertise a button that can't enable anything.
  openSimulatorButton.hidden = simEnabled || Boolean(apiKey);
  const week = currentWeek(seasonSchedule, sortedRankings);
  const done = completedWeek();
  const statuses = new Map(pool.entries.map((entry) => [entry.id, validateEntry(entry, seasonSchedule, done)]));
  const active = pool.entries.filter((entry) => statuses.get(entry.id).status === 'Active');
  const simDone = simEnabled ? Math.max(0, ...seasonSchedule.filter((game) => game.winner || game.tied).map((game) => game.week)) : 0;
  const simWeek = simEnabled ? Math.min(18, simDone + 1) : 0; // next week the simulation will play
  simCurrentWeekButton.disabled = simEnabled && simDone >= 18;
  simCurrentWeekButton.title = simDone >= 18 ? 'All weeks have been simulated.' : 'Complete the next week after the last completed one.';
  poolSummary.innerText = `${pool.entries.length} entries · ${active.length} active · Week ${simEnabled ? `${simWeek} (Simulated)` : week}`;
  addEntryButton.innerText = pool.entries.length ? 'Add team' : 'Add my entry';
  publicBehavior.value = pool.publicBehavior || 'chalk';
  renderWeeklyPickBoard(seasonSchedule, statuses, done, simEnabled ? simWeek : week, simWeek);

  survivorAdvice.innerHTML = '';
  const mine = myEntry();
  if (!mine) { survivorAdvice.innerText = 'Add entries and select your row to see personalized survivor strategy.'; return; }
  const mineStatus = statuses.get(mine.id);
  if (mineStatus.status !== 'Active') { survivorAdvice.innerText = `Your entry is ${mineStatus.status.toLowerCase()}; fix the history to see recommendations.`; return; }
  if (!calculate) {
    survivorAdvice.innerHTML = '<p>Pool or forecast settings changed. Press <strong>Calculate strategy</strong> for fresh survival and leverage advice.</p>';
    return;
  }
  survivorAdvice.innerHTML = '<p>Calculating 10,000 pool simulations…</p>';
  const forecasts = forecastSeason();
  const safe = survivalAdvice(forecasts, week, mineStatus.used);
  const opponents = active.filter((entry) => entry.id !== mine.id).map((entry) => statuses.get(entry.id).used);
  const leverage = leverageAdvice(forecasts, week, mineStatus.used, opponents, pool.publicBehavior, 10000);
  // Replace the temporary progress message rather than leaving it as a third grid item.
  survivorAdvice.innerHTML = '';
  const card = (title, content) => { const node = document.createElement('article'); node.className = 'advice-card'; node.innerHTML = `<h3>${title}</h3>${content}`; survivorAdvice.appendChild(node); };
  if (safe?.picks[0]) card('Best survival path', `<p><strong>${safe.picks[0].team}</strong> · ${(safe.picks[0].probability * 100).toFixed(1)}% · ${safe.picks[0].source}</p><p>Full-path survival: ${(safe.survivalProbability * 100).toFixed(1)}%</p><p>Next: ${safe.picks.slice(1, 5).map((pick) => `W${pick.week} ${pick.team}`).join(' · ') || 'No future games loaded'}</p>`);
  else card('Best survival path', '<p>No eligible current-week team is available.</p>');
  if (leverage) card('Best win-the-pool play', `<p><strong>${leverage.team}</strong> · ${(leverage.probability * 100).toFixed(1)}%</p><p>Projected ownership: ${(leverage.ownership * 100).toFixed(1)}% · estimated title share: ${(leverage.titleShare * 100).toFixed(2)}%</p><p>Assumption: ${pool.publicBehavior} opponents choose from their real remaining teams.</p>`);
};

addEntryButton.addEventListener('click', () => { pool.entries.push({ id: entryId(), name: '', picks: {} }); pool.myEntryId = pool.entries[0]?.id || ''; savePool(); renderSurvivor(); });
renameAllButton.addEventListener('click', () => {
  if (allNamesEditing) {
    allPickBoard.querySelectorAll('input[data-entry-id]').forEach((input) => { const entry = pool.entries.find((candidate) => candidate.id === input.dataset.entryId); if (entry) entry.name = input.value.trim(); });
    allNamesEditing = false;
    renamingRows.clear();
    committedRows.clear();
    savePool();
  } else {
    allNamesEditing = true;
    committedRows.clear();
  }
  renderSurvivor();
  if (allNamesEditing) { const first = allPickBoard.querySelector('input[data-entry-id]'); if (first) { first.focus(); first.select(); } }
});
document.querySelector('#clear-pool').addEventListener('click', () => { if (!confirm('Clear all locally saved survivor entries and pick history?')) return; pool = createPool(); savePool(); renderSurvivor(); renderTable(); });
publicBehavior.addEventListener('change', () => { pool.publicBehavior = publicBehavior.value; savePool(); renderSurvivor(); });
simCurrentWeekButton.addEventListener('click', () => { const next = Math.min(18, completedWeek() + 1); simCompleteWeek(next); simApply(); renderSurvivor(); });
simWeeksButton.addEventListener('click', () => { const through = Math.min(18, Math.max(1, Number(simWeeksInput.value) || 1)); simCompleteThrough(through); simApply(); renderSurvivor(); });
simFullSeasonButton.addEventListener('click', () => { simCompleteThrough(18); simApply(); renderSurvivor(); });
simClearButton.addEventListener('click', () => { if (simResults.size && !confirm('Clear all simulated results?')) return; simClear(); renderSurvivor(); });
// Simulator shortcut: reopen the current view in a new tab with ?sim=1, preserving any
// other query params (mode, etc.). Results are in-memory, so the fresh tab starts clean.
openSimulatorButton.addEventListener('click', () => {
  const url = new URL(window.location.href);
  url.searchParams.set('sim', '1');
  window.open(url.href, '_blank');
});
// Make corrections mirrors the Rename all toggle: the first click unlocks the completed
// week for editing (every entry, eliminated included); the second click re-locks it.
// Picks are persisted on each click, so "Save changes" only needs to leave edit mode.
makeCorrectionsButton.addEventListener('click', () => {
  if (!currentBoardWeek) return;
  correctionsActive = !correctionsActive;
  renderSurvivor();
});
weekTabs.addEventListener('click', (event) => {
  const tab = event.target.closest('.week-tab');
  if (!tab) return;
  const value = tab.dataset.week === 'all' ? 'all' : Number(tab.dataset.week);
  if (value !== 'all' && (!Number.isInteger(value) || value < 1 || value > 18)) return;
  if (value !== currentBoardWeek) correctionsActive = false;
  pool.pickWeek = value;
  savePool();
  renderSurvivor();
});
// Bulk-clear helpers: wipe every entry's pick for the viewed week (optionally through W18).
// Completed weeks are never touched here — corrections flow handles those.
const clearWeekPicks = (week, includeFuture) => {
  if (!Number.isInteger(week) || week < 1 || week > 18) return;
  if (week <= completedWeek()) return;
  const through = includeFuture ? 18 : week;
  const hasPicks = pool.entries.some((entry) => {
    for (let number = week; number <= through; number += 1) if (entry.picks?.[number]) return true;
    return false;
  });
  if (!hasPicks) return;
  const scope = includeFuture ? `Week ${week} and all later weeks` : `Week ${week}`;
  if (!confirm(`Clear every entry's pick for ${scope}?`)) return;
  for (const entry of pool.entries) {
    entry.picks ||= {};
    for (let number = week; number <= through; number += 1) {
      delete entry.picks[number];
    }
  }
  savePool();
  renderSurvivor();
};
clearWeekButton.addEventListener('click', () => { if (currentBoardWeek) clearWeekPicks(currentBoardWeek, false); else clearWeekPicks(1, true); });
clearWeekFutureButton.addEventListener('click', () => { if (currentBoardWeek) clearWeekPicks(currentBoardWeek, true); else clearWeekPicks(1, true); });
const csvValue = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
const parseCsv = (text) => {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(cell.trim()); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row);
  return rows;
};
document.querySelector('#export-pool').addEventListener('click', () => {
  const header = ['Name', ...Array.from({ length: 18 }, (_, index) => `W${index + 1}`)];
  const rows = pool.entries.map((entry) => [entry.name || '', ...Array.from({ length: 18 }, (_, index) => entry.picks?.[index + 1] || '')]);
  const csv = [header, ...rows].map((row) => row.map(csvValue).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'pickem-survivor-pool.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
});
document.querySelector('#import-pool').addEventListener('click', () => importPoolFile.click());
importPoolFile.addEventListener('change', async () => {
  const file = importPoolFile.files?.[0];
  if (!file) return;
  try {
    const rows = parseCsv(await file.text());
    const header = rows.shift()?.map((cell) => cell.toLowerCase().replaceAll(' ', ''));
    if (!header || header[0] !== 'name') throw new Error('Expected a CSV whose first column is Name.');
    const weekColumns = Array.from({ length: 18 }, (_, index) => header.indexOf(`w${index + 1}`));
    if (weekColumns.some((column) => column < 0)) throw new Error('Expected W1 through W18 columns.');
    const entries = rows.map((row) => {
      const picks = {};
      weekColumns.forEach((column, index) => { if (row[column]) picks[index + 1] = row[column]; });
      return { id: entryId(), name: row[0] || '', picks };
    }).filter((entry) => entry.name || Object.keys(entry.picks).length);
    pool = { ...createPool(), entries };
    pool.myEntryId = pool.entries[0]?.id || '';
    savePool();
    renderSurvivor();
    renderTable();
  } catch (error) {
    alert(`Could not import pool history: ${error.message}`);
  } finally {
    importPoolFile.value = '';
  }
});
document.querySelector('#calculate-survivor').addEventListener('click', () => {
  survivorAdvice.innerHTML = '<p>Calculating 10,000 pool simulations…</p>';
  // Two frames let the status paint before the synchronous simulation starts.
  requestAnimationFrame(() => requestAnimationFrame(() => renderSurvivor(true)));
});
updateModeUI();

slider.value = String(100 - weightPercent);
const updateBlendLabel = () => {
  blendLabel.innerText = `Model ${weightPercent}% ⟷ Market ${100 - weightPercent}%`;
};
slider.addEventListener('input', () => {
  weightPercent = 100 - Number(slider.value);
  localStorage.setItem(WEIGHT_STORAGE_KEY, String(weightPercent));
  updateBlendLabel();
  renderSurvivor();
  renderTable();
});

// Preset buttons (Model / 50-50 / Market) snap the slider to a fixed blend
document.querySelectorAll('.controls-axis button').forEach((btn) => {
  btn.addEventListener('click', () => {
    weightPercent = Number(btn.dataset.modelPercent);
    slider.value = String(100 - weightPercent);
    localStorage.setItem(WEIGHT_STORAGE_KEY, String(weightPercent));
    updateBlendLabel();
    renderSurvivor();
    renderTable();
  });
});

updateBlendLabel();
renderSurvivor();
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
