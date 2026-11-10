/**
 * UI harness: renders any screen/state of src/ui with mock data over a static
 * scenic backdrop, so it can be screenshotted and e2e-tested without the game.
 *
 *   dev/ui.html?screen=home|join|busy|error|lobby|countdown|hud|finished|results|fame
 *              &bg=day|night|golden|dawn   backdrop (night also switches the UI tone)
 *              &host=1 &players=8 &canStart=0 &bots=2      lobby
 *              &count=3|2|1|GO                              countdown
 *              &live=1                                      hud: animate at 60 Hz
 *              &saved=pending|ok|local &self=3              results
 *              &fame=loading|empty|N                        fame
 *              &shot=1                                      hide harness chrome
 *
 * Every handler call is recorded in window.__calls as [name, ...args].
 */
import { UI } from '../src/ui/UI.js';
import { DEFAULT_SETTINGS, PLAYER_COLORS } from '../src/contracts.js';

const q = new URLSearchParams(location.search);
const param = (k, d) => (q.has(k) ? q.get(k) : d);
const screen = param('screen', 'home');
const bg = param('bg', 'day');
if (q.has('shot')) document.documentElement.classList.add('shot');

/* ------------------------------------------------------------------ backdrop */

const PALETTES = {
  day: { sky: ['#7ea8d0', '#b7cfe3', '#efe2d6'], sun: '#fff7e8', glow: 'rgba(255,240,215,.55)', ridges: ['#b4c8db', '#9db4cb', '#86a0bb', '#6e89a8', '#5a7393'], snow: '#f8f9fa', shade: '#dbe4ee', trees: '#3d5068', sunPos: [0.72, 0.3] },
  golden: { sky: ['#6f86b6', '#e0a68c', '#f8d59f'], sun: '#fff1cf', glow: 'rgba(255,214,150,.6)', ridges: ['#d9a99c', '#bb8c8f', '#9b7484', '#7c5f78', '#5f4b68'], snow: '#fbefe4', shade: '#ead2c6', trees: '#4b3a55', sunPos: [0.64, 0.5] },
  dawn: { sky: ['#4f5f95', '#b896b2', '#f0c4ad'], sun: '#ffe9dc', glow: 'rgba(255,200,180,.5)', ridges: ['#a690ad', '#8c7a9e', '#73678c', '#5c5679', '#474665'], snow: '#f3ecef', shade: '#d9d0dc', trees: '#3a3754', sunPos: [0.3, 0.52] },
  night: { sky: ['#070b22', '#161f45', '#353b66'], sun: '#f4f1e2', glow: 'rgba(190,200,255,.25)', ridges: ['#2c3560', '#252e55', '#1e2649', '#181f3d', '#121831'], snow: '#c3cde4', shade: '#93a0c0', trees: '#0b1024', sunPos: [0.76, 0.22], stars: true },
};

function drawBackdrop(name) {
  const P = PALETTES[name] || PALETTES.day;
  const W = 1600;
  const H = 1000;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const ridge = (base, amp, freq, phase) => {
    let d = `M0 ${H}`;
    for (let x = 0; x <= W; x += 20) {
      const y = base - amp * (0.55 * Math.sin(x * freq + phase) + 0.3 * Math.sin(x * freq * 2.3 + phase * 1.7) + 0.15 * Math.sin(x * freq * 5.1 + phase * 0.3));
      d += ` L${x} ${y.toFixed(1)}`;
    }
    return `${d} L${W} ${H} Z`;
  };
  const stars = P.stars
    ? Array.from({ length: 140 }, () => `<circle cx="${(rnd() * W).toFixed(0)}" cy="${(rnd() * H * 0.55).toFixed(0)}" r="${(rnd() * 1.3 + 0.3).toFixed(2)}" fill="#fff" opacity="${(rnd() * 0.7 + 0.2).toFixed(2)}"/>`).join('')
    : '';
  const [sx, sy] = P.sunPos;
  const ridges = P.ridges.map((c, i) => `<path d="${ridge(H * (0.42 + i * 0.075), 60 + i * 18, 0.0032 + i * 0.0011, i * 1.9 + 0.4)}" fill="${c}"/>`).join('');
  // the riding slope (Alto-style: big white curve descending to the right)
  const slopeY = (x) => H * 0.66 + (x / W) * H * 0.2 - Math.sin(x * 0.004) * 26;
  let slope = `M0 ${H}`;
  for (let x = 0; x <= W; x += 16) slope += ` L${x} ${slopeY(x).toFixed(1)}`;
  slope += ` L${W} ${H} Z`;
  const tree = (x, s) => {
    const y = slopeY(x) + 4;
    return `<path d="M${x} ${y - 70 * s} L${x - 16 * s} ${y - 20 * s} L${x - 7 * s} ${y - 22 * s} L${x - 20 * s} ${y} L${x + 20 * s} ${y} L${x + 7 * s} ${y - 22 * s} L${x + 16 * s} ${y - 20 * s} Z" fill="${P.trees}"/>`;
  };
  const rx = W * 0.4;
  const ry = slopeY(rx);
  const ang = (Math.atan2(slopeY(rx + 10) - slopeY(rx - 10), 20) * 180) / Math.PI;
  const rider = `<g transform="translate(${rx} ${ry}) rotate(${ang.toFixed(1)}) scale(1.7) translate(-22 -34)" color="${P.trees}">
      <path d="M5 34.2 Q21 32.4 38 29.8" stroke="currentColor" stroke-width="2.1" fill="none" stroke-linecap="round"/>
      <path d="M14.8 32.6 L18.2 26.4 L16.4 21.8 M26.2 31.2 L24.6 25.4 L20 21.8" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      <path d="M18 22.2 L21.6 15.2" stroke="currentColor" stroke-width="3.6" stroke-linecap="round"/>
      <circle cx="23.2" cy="11.4" r="3.2" fill="currentColor"/>
      <path fill="${PLAYER_COLORS[4]}" d="M22.4 14.3 C18 13.1 13.6 15 9.4 13.2 C7.4 12.4 3 13.5 -6 15 C1 10.9 9.6 10.4 13 11.3 C16.4 12.2 19.2 11.6 22.6 12.6 Z"/>
    </g>`;
  document.getElementById('stage').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P.sky[0]}"/><stop offset=".55" stop-color="${P.sky[1]}"/><stop offset="1" stop-color="${P.sky[2]}"/></linearGradient>
      <radialGradient id="glow"><stop offset="0" stop-color="${P.glow}"/><stop offset="1" stop-color="rgba(255,255,255,0)"/></radialGradient>
      <linearGradient id="snow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P.snow}"/><stop offset="1" stop-color="${P.shade}"/></linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#sky)"/>
    ${stars}
    <circle cx="${W * sx}" cy="${H * sy}" r="260" fill="url(#glow)"/>
    <circle cx="${W * sx}" cy="${H * sy}" r="${P.stars ? 26 : 38}" fill="${P.sun}"/>
    ${ridges}
    <path d="${slope}" fill="url(#snow)"/>
    ${[90, 170, 230, 980, 1060, 1350, 1420, 1500].map((x, i) => tree(x, 0.7 + (i % 3) * 0.25)).join('')}
    ${rider}
  </svg>`;
  document.body.style.background = P.sky[2];
}
drawBackdrop(bg);

/* ------------------------------------------------------------------ mocks */

const NAMES = ['Dani', 'Valentina', 'Mateo', 'Sofía', 'Juan Pablo', 'Camila', 'Nico', 'Isabella', 'Santiago', 'Lucía', 'Tomás', 'Mariana'];

export function makePlayers(n, { selfIndex = 0, notReady = false } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: NAMES[i % NAMES.length],
    colorIndex: (i * 5 + 4) % PLAYER_COLORS.length,
    isHost: i === 0,
    connected: !(i === 5),
    ready: notReady ? i % 3 !== 2 : true,
    _self: i === selfIndex,
  }));
}

export function makeResults(n, { dnf = true } = {}) {
  const players = makePlayers(n);
  let t = 94523;
  const ranking = players.map((p, i) => {
    t += i === 0 ? 0 : 380 + ((i * 937) % 2400);
    const isDnf = dnf && n > 3 && i === n - 1;
    return {
      id: p.id,
      name: p.name,
      colorIndex: p.colorIndex,
      timeMs: isDnf ? -1 : t,
      progress: isDnf ? 0.82 : 1,
      stats: { score: 420 - i * 37 + ((i * 53) % 90), bestCombo: 160 - i * 11, flips: 9 - i, grindPx: 1200, crashes: i % 3, coins: 20 - i, topSpeed: 700 },
    };
  });
  return { raceId: 3, seed: 1234, settings: { ...DEFAULT_SETTINGS, length: 'classic' }, ranking };
}

export function makeFame(n) {
  const lengths = ['classic', 'sprint', 'marathon'];
  return Array.from({ length: n }, (_, i) => ({
    name: NAMES[(i * 7) % NAMES.length],
    colorIndex: (i * 3 + 2) % PLAYER_COLORS.length,
    timeMs: [94523, 61220, 171904][i % 3] + i * 1311,
    length: lengths[i % 3],
    players: 2 + ((i * 5) % 10),
    score: 380 - i * 13,
    room: ['K7QXP', 'MN4RT', 'ZQ8HV'][i % 3],
    at: Date.now() - i * 3.7 * 3600 * 1000 - 120000,
  }));
}

export function hudFrame(t = 0, total = 8) {
  const racers = Array.from({ length: total }, (_, i) => ({
    id: `p${i}`,
    name: NAMES[i],
    color: PLAYER_COLORS[(i * 5 + 4) % PLAYER_COLORS.length],
    progress: Math.min(1, 0.18 + i * 0.045 + t * 0.00002 * (1 + i * 0.05)),
    isLocal: i === 2,
    finished: false,
  }));
  return {
    timeMs: 52340 + t,
    speedMps: 17.6 + Math.sin(t / 900) * 2,
    progress: racers[2].progress,
    position: 3,
    total,
    scarf: 0.64,
    boostT: 2.4,
    boostLevel: 2,
    hoverT: 3.2,
    magnetT: 0,
    combo: { points: 60, mult: 2, tricks: ['Backflip', 'Grind'] },
    racers,
  };
}

/* ------------------------------------------------------------------ UI */

window.__calls = [];
const log =
  (name) =>
  (...args) => {
    window.__calls.push([name, ...args]);
    if (!q.has('shot')) console.log('[ui]', name, ...args);
  };
const handlers = Object.fromEntries(
  ['onCreate', 'onJoin', 'onPractice', 'onProfileChange', 'onOpenFame', 'onSettings', 'onStart', 'onLeave', 'onCopyLink', 'onPlayAgain', 'onBackToLobby', 'onToggleMute', 'onInput'].map((n) => [n, log(n)])
);
const ui = new UI(document.getElementById('ui'), handlers);
window.ui = ui;
window.mock = { makePlayers, makeResults, makeFame, hudFrame };
ui.setTone(bg === 'night' ? 'night' : 'day');

let muted = false;
handlers.onToggleMute = (...a) => {
  log('onToggleMute')(...a);
  muted = !muted;
  ui.setMuted(muted);
};

const host = param('host', '1') === '1';
const nPlayers = Number(param('players', 5));

function lobbyView(overrides = {}) {
  const players = makePlayers(nPlayers, { notReady: q.has('notready') }).map(({ _self, ...p }) => p);
  const selfId = host ? 'p0' : `p${Math.min(2, nPlayers - 1)}`;
  return {
    code: 'K7QXP',
    shareUrl: `${location.origin}/snowline/?room=K7QXP`,
    players,
    selfId,
    isHost: host,
    settings: { ...DEFAULT_SETTINGS, length: param('length', 'classic'), startTime: param('time', 'golden'), weather: param('weather', 'snow'), bots: Number(param('bots', 2)) },
    canStart: param('canStart', '1') === '1',
    ...overrides,
  };
}

// Lobby harness keeps its own state so settings clicks round-trip like the real game.
let lobbyState = null;
const origSettings = handlers.onSettings;
handlers.onSettings = (partial) => {
  origSettings(partial);
  if (lobbyState) {
    lobbyState = { ...lobbyState, settings: { ...lobbyState.settings, ...partial } };
    ui.setLobby(lobbyState);
  }
};
handlers.onOpenFame = (...a) => {
  log('onOpenFame')(...a);
  if (screen === 'fame') return; // the fame screen drives the data itself
  ui.setHallOfFame(null);
  setTimeout(() => ui.setHallOfFame(makeFame(9)), 700);
};

switch (screen) {
  case 'home':
  case 'join':
  case 'busy':
  case 'error':
    ui.setProfile({ name: screen === 'join' ? '' : param('name', 'Dani'), colorIndex: Number(param('color', 4)) });
    if (screen === 'join') ui.setJoinCode(param('code', 'K7QXP'));
    ui.show('home');
    if (screen === 'busy') {
      ui.home.lastAction = ui.home.createBtn;
      ui.setBusy(true, 'Creating room…');
    }
    if (screen === 'error') ui.showError(param('msg', 'Room K7QXP was not found. Check the code and try again.'));
    ui.setConnection(param('conn', 'online'));
    break;
  case 'lobby':
    lobbyState = lobbyView();
    ui.show('lobby');
    ui.setLobby(lobbyState);
    if (q.has('joins')) {
      // live join / leave demo
      let k = nPlayers;
      setInterval(() => {
        const all = makePlayers(12).map(({ _self, ...p }) => p);
        k = k >= 12 ? 3 : k + 1;
        lobbyState = { ...lobbyState, players: all.slice(0, k) };
        ui.setLobby(lobbyState);
      }, 1200);
    }
    break;
  case 'countdown':
    ui.show('race');
    ui.updateHud({ ...hudFrame(0), timeMs: 0, speedMps: 0, combo: { points: 0, mult: 1, tricks: [] }, boostT: 0, hoverT: 0, scarf: 0.2, position: 0, racers: hudFrame(0).racers.map((r) => ({ ...r, progress: 0 })) });
    ui.setCountdown(param('count', '3') === 'GO' ? 'GO' : Number(param('count', 3)));
    if (q.has('loop')) {
      const seq = [3, 2, 1, 'GO'];
      let i = 0;
      setInterval(() => ui.setCountdown(seq[i++ % 4]), 1000);
    }
    break;
  case 'hud':
  case 'finished': {
    ui.show('race');
    ui.updateHud(hudFrame(0));
    if (screen === 'finished') {
      ui.updateHud({ ...hudFrame(0), combo: { points: 0, mult: 1, tricks: [] } });
      ui.setFinished(2, 94523);
    } else if (!q.has('quiet')) {
      ui.trickToast('Backflip', 10);
      setTimeout(() => ui.trickToast('Grind', 20), 250);
      ui.announce(param('announce', 'Valentina finished 1st!'), 'good');
    }
    if (q.has('live')) {
      const t0 = performance.now();
      const tick = () => {
        ui.updateHud(hudFrame(performance.now() - t0));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      setInterval(() => ui.trickToast(['Backflip', 'Double Backflip', 'Grind', 'Chasm'][Math.floor(Math.random() * 4)], 10), 1800);
      setInterval(() => ui.comboBanked(180, 3, 2), 4100);
    }
    break;
  }
  case 'results': {
    const n = Number(param('players', 6));
    ui.show('results');
    const results = makeResults(n);
    ui.setResults({ results, selfId: param('self', host ? 'p0' : 'p2'), isHost: host, saved: param('saved', 'ok') });
    break;
  }
  case 'fame': {
    ui.setProfile({ name: 'Dani', colorIndex: 4 });
    ui.show('home');
    ui.openFame();
    const f = param('fame', '9');
    ui.setHallOfFame(f === 'loading' ? null : f === 'empty' ? [] : makeFame(Number(f)));
    break;
  }
  default:
    ui.show(screen);
}

// harness nav
const bar = document.getElementById('dev-bar');
for (const s of ['home', 'join', 'busy', 'error', 'lobby', 'countdown', 'hud', 'finished', 'results', 'fame']) {
  const a = document.createElement('a');
  const p = new URLSearchParams(q);
  p.set('screen', s);
  a.href = `?${p}`;
  a.textContent = s;
  bar.append(a);
}
for (const b of ['day', 'golden', 'dawn', 'night']) {
  const a = document.createElement('a');
  const p = new URLSearchParams(q);
  p.set('bg', b);
  a.href = `?${p}`;
  a.textContent = b;
  bar.append(a);
}
