/**
 * Race HUD: timer + position, progress track with every racer, speed + scarf
 * gauge, power-up rings, combo readout, trick toasts, announcements,
 * countdown and the "you finished" overlay.
 *
 * update() runs every frame, so every write is diffed against a cache and
 * only touches the DOM when the visible value changes.
 */
import { h, icon, replay, setText } from './dom.js';
import { ICONS } from './icons.js';
import { formatTime, ordinalSuffix } from './format.js';

const RING_C = 2 * Math.PI * 15; // ring circumference (r = 15)
const BOOST_NAMES = ['', 'Boost', 'Super boost', 'Ultra boost'];
/** Speedometer: km/h at the right end of the arc, and the arc's sweep (degrees, centred on 12 o'clock). */
const SPEEDO_MAX = 150;
const SPEEDO_SWEEP = 180;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Small SVG builder for the HUD widgets (static markup, no user data). */
function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

/** Wavy ribbon outline for the scarf meter (viewBox 0 0 120 14): a scarf blowing in the wind. */
const RIBBON_PATH = 'M2 4 C22 1 38 6 60 3.5 C82 1 98 5 118 2.5 L114 7 L118 11.5 C98 14 82 10 60 12.5 C38 15 22 10 2 12 Z';
let ribbonSeq = 0;

export class HudView {
  constructor() {
    this.cache = {};
    this.markers = new Map();
    // Viewport size, cached: reading innerWidth/innerHeight every frame can force a layout.
    this.vw = innerWidth;
    this.vh = innerHeight;
    addEventListener('resize', () => {
      this.vw = innerWidth;
      this.vh = innerHeight;
    });
    this.ringMax = { hover: 0, magnet: 0 };

    // top-left: one plaque with the race time and the position
    this.timeEl = h('span', { class: 'hud-time', 'data-testid': 'hud-timer', 'aria-label': 'Race time' }, '0:00.00');
    this.posEl = h('b', {}, '–');
    this.totalEl = h('span', {}, '/–');
    this.posWrap = h('span', { class: 'hud-pos', 'data-testid': 'hud-position', 'aria-label': 'Position' }, this.posEl, this.totalEl);
    // under the plaque: nearest rider ahead / behind, in seconds
    this.gapEl = h('span', { class: 'hud-gaps', 'data-testid': 'hud-gaps', 'aria-hidden': 'true' });
    // points: banked tricks + coins (their own contest next to the time), with the coin count
    this.scoreEl = h('b', {}, '0');
    this.coinEl = h('span', {}, '0');
    this.scoreCell = h(
      'span',
      { class: 'plaque__cell hud-score', 'data-testid': 'hud-score', 'aria-label': 'Points' },
      icon(ICONS.star, 'icon plaque__icon'),
      this.scoreEl,
      h('span', { class: 'hud-coins', 'data-testid': 'hud-coins', 'aria-label': 'Coins' }, icon(ICONS.coin, 'icon'), this.coinEl)
    );
    this.plaque = h(
      'div',
      { class: 'plaque' },
      h('span', { class: 'plaque__cell' }, icon(ICONS.clock, 'icon plaque__icon'), this.timeEl),
      h('span', { class: 'plaque__sep', 'aria-hidden': 'true' }),
      h('span', { class: 'plaque__cell' }, icon(ICONS.podium, 'icon plaque__icon'), this.posWrap),
      h('span', { class: 'plaque__sep', 'aria-hidden': 'true' }),
      this.scoreCell
    );
    const tl = h('div', { class: 'hud__tl' }, this.plaque, this.gapEl);

    // top-centre: progress track + combo readout
    this.fill = h('span', { class: 'track__fill' });
    this.markerLayer = h('span', { class: 'track__markers' });
    this.track = h(
      'div',
      { class: 'track', 'data-testid': 'hud-progress', role: 'progressbar', 'aria-label': 'Course progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' },
      h('span', { class: 'track__line' }),
      this.fill,
      this.markerLayer,
      h('span', { class: 'track__flag' }, icon(ICONS.finish, 'icon'))
    );
    this.comboTricks = h('span', { class: 'combo__tricks' });
    this.comboMult = h('span', { class: 'combo__mult' });
    this.comboPts = h('span', { class: 'combo__pts' });
    this.combo = h('div', { class: 'combo', 'data-testid': 'hud-combo', 'aria-live': 'off' }, this.comboTricks, this.comboMult, this.comboPts);
    this.comboAnchor = h('div', { class: 'combo-anchor' }, this.combo);
    const top = h('div', { class: 'hud__top' }, this.track, this.comboAnchor);

    // bottom-left: speedometer (a dot rides a segmented arc), the scarf ribbon, power-up rings
    this.speedEl = h('b', {}, '0');
    this.speedDot = svg('g', { class: 'speedo__dot' }, svg('circle', { cx: '50', cy: '9', r: '4.2' }));
    const arc = 'M9 50 A41 41 0 0 1 91 50';
    const speedoSvg = svg('svg', { class: 'speedo__svg', viewBox: '0 0 100 56', 'aria-hidden': 'true' }, svg('path', { class: 'speedo__track', d: arc }), svg('path', { class: 'speedo__ticks', d: arc }), this.speedDot);
    this.speedo = h('span', { class: 'speedo', 'data-level': '0' }, speedoSvg, h('span', { class: 'hud-speed', 'data-testid': 'hud-speed' }, this.speedEl, h('small', {}, 'km/h')));
    // scarf ribbon: a fill (scaleX) clipped to a wavy scarf outline, and a thin boost-time line under it
    const clipId = `ribbon-clip-${++ribbonSeq}`;
    this.gaugeFill = svg('rect', { class: 'gauge__fill', x: '0', y: '0', width: '120', height: '14' });
    this.gaugeBoost = h('span', { class: 'gauge__boost' });
    const ribbon = svg(
      'svg',
      { class: 'ribbon', viewBox: '0 0 120 14', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      svg('defs', {}, svg('clipPath', { id: clipId }, svg('path', { d: RIBBON_PATH }))),
      svg('g', { 'clip-path': `url(#${clipId})` }, svg('rect', { class: 'ribbon__bg', x: '0', y: '0', width: '120', height: '14' }), this.gaugeFill),
      svg('path', { class: 'ribbon__edge', d: RIBBON_PATH })
    );
    this.gauge = h('span', { class: 'gauge', 'data-testid': 'hud-scarf', role: 'meter', 'aria-label': 'Scarf', 'aria-valuemin': '0', 'aria-valuemax': '100' }, ribbon, this.gaugeBoost);
    this.boostTag = h('span', { class: 'gauge__tag', 'data-testid': 'hud-boost' });
    this.rings = { hover: this._ring('hover', ICONS.feather, 'Feather'), magnet: this._ring('magnet', ICONS.magnet, 'Magnet') };
    const bl = h(
      'div',
      { class: 'hud__bl' },
      this.speedo,
      h('div', { class: 'hud__meter' }, h('span', { class: 'gauge-label' }, 'Scarf', this.boostTag), this.gauge, h('div', { class: 'rings' }, this.rings.hover.el, this.rings.magnet.el))
    );

    this.toastLayer = h('div', { class: 'trick-layer', 'aria-hidden': 'true' });
    this.announceEl = h('div', { class: 'announce', role: 'status', 'aria-live': 'polite', 'data-testid': 'announce' });
    this.countdownEl = h('div', { class: 'countdown', 'data-testid': 'countdown', 'aria-live': 'assertive', hidden: true });

    this.finishedPlace = h('span', { class: 'finished__place' });
    this.finishedTime = h('span', { class: 'finished__time' });
    this.finishedEl = h(
      'div',
      { class: 'finished', 'data-testid': 'finished-overlay', hidden: true, role: 'status' },
      h('div', { class: 'glass finished__card' }, h('p', { class: 'eyebrow' }, 'Finished'), this.finishedPlace, this.finishedTime, h('p', { class: 'waiting' }, h('span', { class: 'waiting__text' }, 'Waiting for the others'), h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))))
    );

    // status chips under the progress bar: tailwind (catch-up), race closing, watching (spectating)
    this.tailwindEl = h('span', { class: 'status-chip status-chip--wind', 'data-testid': 'hud-tailwind', hidden: true }, icon(ICONS.wind, 'icon icon--sm'), 'Tailwind');
    this.closingEl = h('span', { class: 'status-chip status-chip--closing', 'data-testid': 'hud-closing', hidden: true }, icon(ICONS.clock, 'icon icon--sm'), h('span', {}));
    this.watchEl = h('span', { class: 'status-chip status-chip--watch', 'data-testid': 'hud-watching', hidden: true }, icon(ICONS.eye, 'icon icon--sm'), h('span', {}), h('small', {}, 'Tap to switch'));
    this.statusEl = h('div', { class: 'hud-status' }, this.tailwindEl, this.closingEl, this.watchEl);
    // announcements get their own row in the top stack, so they never sit on trick toasts or the boost banner
    top.append(this.statusEl, this.announceEl);

    this.hud = h('div', { class: 'hud', 'data-testid': 'hud' }, tl, top, bl);
    this.el = h('section', { class: 'screen screen--race', 'data-screen': 'race', 'aria-label': 'Race', hidden: true }, this.hud, this.toastLayer, this.countdownEl, this.finishedEl);
  }

  /** Clears per-race state (called when a race screen is entered fresh). */
  reset() {
    this.cache = { cd: this.cache.cd };
    this.ringMax = { hover: 0, magnet: 0 };
    for (const m of this.markers.values()) m.el.remove();
    this.comboTricks.replaceChildren();
    this.markers.clear();
    this.toastLayer.replaceChildren();
    this.announceEl.replaceChildren();
    this.finishedEl.hidden = true;
    this.finishedEl.classList.remove('is-compact');
    this.hud.classList.remove('is-finished');
    this.cache.gaps = '';
    this.gapEl.textContent = '';
    this.tailwindEl.hidden = true;
    this.closingEl.hidden = true;
    this.watchEl.hidden = true;
    this.combo.classList.remove('is-on', 'pop');
    // (the countdown is left alone: Game may call setCountdown(3) just before show('race'))
    for (const r of Object.values(this.rings)) r.el.classList.remove('is-on');
  }

  /* ---------------- per frame ---------------- */

  update(hud) {
    if (!hud) return;
    const c = this.cache;

    setText(this.timeEl, formatTime(hud.timeMs));

    const pos = hud.position > 0 ? String(hud.position) : '–';
    const total = hud.total > 0 ? `/${hud.total}` : '';
    setText(this.posEl, pos);
    setText(this.totalEl, total);

    // points + coins: a short pop when points land
    const score = Math.round(hud.score || 0);
    if (c.score !== score) {
      if (c.score !== undefined && score > c.score) replay(this.scoreCell, 'pop');
      c.score = score;
      this.scoreEl.textContent = score.toLocaleString('en-US');
    }
    setText(this.coinEl, String(hud.coins || 0));

    // progress (local fill)
    const prog = clamp01(hud.progress);
    const p1000 = Math.round(prog * 1000);
    if (c.prog !== p1000) {
      c.prog = p1000;
      this.fill.style.transform = `scaleX(${p1000 / 1000})`;
      if (c.progPct !== Math.round(prog * 100)) {
        c.progPct = Math.round(prog * 100);
        this.track.setAttribute('aria-valuenow', String(c.progPct));
      }
    }

    // racer markers
    const racers = hud.racers || [];
    if (racers.length || this.markers.size) this._markers(racers);

    // speed: number + the dot on the arc (rotation only, in half-degree steps)
    const kmh = Math.max(0, Math.round((hud.speedMps || 0) * 3.6));
    setText(this.speedEl, kmh);
    const deg = Math.round((Math.min(kmh, SPEEDO_MAX) / SPEEDO_MAX - 0.5) * SPEEDO_SWEEP * 2) / 2;
    if (c.deg !== deg) {
      c.deg = deg;
      this.speedDot.style.transform = `rotate(${deg}deg)`;
    }

    // scarf gauge
    const scarf = Math.round(clamp01(hud.scarf) * 200);
    if (c.scarf !== scarf) {
      c.scarf = scarf;
      this.gaugeFill.style.transform = `scaleX(${scarf / 200})`;
      this.gauge.setAttribute('aria-valuenow', String(Math.round(scarf / 2)));
    }
    const level = hud.boostT > 0 ? Math.max(1, Math.min(3, hud.boostLevel | 0)) : 0;
    if (c.level !== level) {
      if (level > (c.level || 0)) replay(this.gauge, 'is-surge');
      c.level = level;
      this.gauge.dataset.level = String(level);
      this.speedo.dataset.level = String(level);
      this.boostTag.dataset.level = String(level);
      setText(this.boostTag, BOOST_NAMES[level]);
    }
    // boost time left as a thin overlay (relative to the longest seen this boost)
    if (level) {
      if (!c.boostMax || hud.boostT > c.boostMax) c.boostMax = hud.boostT;
      const b = Math.round((hud.boostT / c.boostMax) * 100);
      if (c.boost !== b) {
        c.boost = b;
        this.gaugeBoost.style.transform = `scaleX(${b / 100})`;
      }
    } else if (c.boost !== 0) {
      c.boost = 0;
      c.boostMax = 0;
      this.gaugeBoost.style.transform = 'scaleX(0)';
    }

    this._updateRing('hover', hud.hoverT);
    this._updateRing('magnet', hud.magnetT);

    this._combo(hud.combo);

    // nearest riders ahead / behind
    const g = hud.gaps;
    const fmtGap = (x) => `${x.name} ${Math.abs(x.gapS) < 10 ? Math.abs(x.gapS).toFixed(1) : Math.round(Math.abs(x.gapS))} s`;
    const gapText = g ? [g.ahead ? `▲ ${fmtGap(g.ahead)}` : '', g.behind ? `▼ ${fmtGap(g.behind)}` : ''].filter(Boolean).join(' · ') : '';
    if (c.gaps !== gapText) {
      c.gaps = gapText;
      this.gapEl.textContent = gapText;
    }
    const wind = !!hud.tailwind;
    if (c.wind !== wind) {
      c.wind = wind;
      this.tailwindEl.hidden = !wind;
    }
  }

  /** "Race closes in 0:24" while a race is closing; null hides it. */
  setClosing(msLeft) {
    const text = msLeft === null || msLeft === undefined ? '' : `Race closes in ${formatClock(msLeft)}`;
    if (this.cache.closing === text) return;
    this.cache.closing = text;
    this.closingEl.hidden = !text;
    this.closingEl.lastChild.textContent = text;
  }

  /** Spectating after the finish: {name, place} or null. The finish card shrinks to a corner chip. */
  setWatching(info) {
    const text = info ? `Watching ${info.name}${info.place ? ` · ${ordinal(info.place)}` : ''}` : '';
    if (this.cache.watch === text) return;
    this.cache.watch = text;
    this.watchEl.hidden = !text;
    this.watchEl.children[1].textContent = text;
    if (text) this.finishedEl.classList.add('is-compact');
  }

  /** Short reason label next to the rider after a crash (uses the trick-toast anchor). */
  crashLabel(text) {
    const el = h('div', { class: 'trick trick--crash', 'data-testid': 'crash-label' }, h('span', { class: 'trick__label' }, text));
    for (const t of this.toastLayer.children) t.style.setProperty('--lift', `${(parseFloat(t.style.getPropertyValue('--lift')) || 0) + 1}`);
    this.toastLayer.append(el);
    setTimeout(() => el.remove(), 1250);
  }

  _markers(racers) {
    const seen = new Set();
    for (const r of racers) {
      seen.add(r.id);
      let m = this.markers.get(r.id);
      if (!m) {
        const dot = h('span', { class: 'marker__dot' });
        const el = h('span', { class: 'marker', 'data-testid': `hud-marker-${r.id}` }, dot);
        this.markerLayer.append(el);
        m = { el, dot, p: -1, key: '' };
        this.markers.set(r.id, m);
      }
      const key = `${r.color}|${r.isLocal}|${r.finished}`;
      if (m.key !== key) {
        m.key = key;
        m.el.style.setProperty('--c', r.color);
        m.el.classList.toggle('is-local', !!r.isLocal);
        m.el.classList.toggle('is-done', !!r.finished);
        m.el.title = r.name;
      }
      const p = Math.round(clamp01(r.progress) * 1000);
      if (m.p !== p) {
        m.p = p;
        m.el.style.transform = `translate3d(${p / 10}%,0,0)`;
      }
    }
    for (const [id, m] of this.markers) {
      if (!seen.has(id)) {
        m.el.remove();
        this.markers.delete(id);
      }
    }
  }

  _ring(kind, svgIcon, label) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '18');
    circle.setAttribute('cy', '18');
    circle.setAttribute('r', '15');
    circle.setAttribute('class', 'ring__arc');
    circle.style.strokeDasharray = `${RING_C}`;
    const bg = circle.cloneNode();
    bg.setAttribute('class', 'ring__bg');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('class', 'ring__svg');
    svg.append(bg, circle);
    const el = h('span', { class: `ring ring--${kind}`, 'data-testid': `hud-${kind}`, title: label, 'aria-label': label }, svg, icon(svgIcon, 'icon icon--sm ring__icon'));
    return { el, circle, last: -1 };
  }

  _updateRing(kind, t) {
    const r = this.rings[kind];
    const on = t > 0;
    if (!on) {
      if (r.last !== 0) {
        r.last = 0;
        this.ringMax[kind] = 0;
        r.el.classList.remove('is-on');
      }
      return;
    }
    if (t > this.ringMax[kind]) this.ringMax[kind] = t;
    const frac = Math.round((t / this.ringMax[kind]) * 200) / 200;
    if (r.last !== frac) {
      if (r.last <= 0) r.el.classList.add('is-on');
      r.last = frac;
      r.circle.style.strokeDashoffset = String(RING_C * (1 - frac));
      r.el.classList.toggle('is-ending', t < 1.5);
    }
  }

  _combo(combo) {
    const tricks = combo?.tricks || [];
    const active = tricks.length > 0 || (combo?.points || 0) > 0;
    const key = active ? `${tricks.join('|')}#${combo.mult}#${combo.points}` : '';
    if (this.cache.combo === key) return;
    const wasActive = !!this.cache.combo;
    this.cache.combo = key;
    if (!active) {
      this.combo.classList.remove('is-on');
      return;
    }
    const shown = tricks.length > 3 ? ['…', ...tricks.slice(-3)] : tricks;
    const chips = this.comboTricks.children;
    while (chips.length > shown.length) this.comboTricks.lastChild.remove();
    shown.forEach((t, i) => {
      if (!chips[i]) this.comboTricks.append(h('span', { class: 'trick-chip' }));
      if (chips[i].textContent !== t) chips[i].textContent = t;
    });
    this.comboMult.textContent = combo.mult > 1 ? `×${combo.mult}` : '';
    this.comboPts.textContent = String(combo.points | 0);
    this.combo.classList.add('is-on');
    if (wasActive || tricks.length) replay(this.combo, 'pop');
  }

  /** Where trick toasts pop (screen px, e.g. from Renderer.worldToScreen of the local rider); null = default. */
  setTrickAnchor(x, y) {
    const st = this.toastLayer.style;
    if (x === null || x === undefined) {
      st.left = '';
      st.top = '';
      st.transform = '';
      this._anchor = '';
      return;
    }
    // keep a little above the rider and inside the viewport
    const px = Math.max(90, Math.min(this.vw - 90, x));
    // Toasts grow upward from this point. When the rider is high on screen (big air, short phones) the
    // anchor drops far enough below the rider that the toast never sits on top of it.
    const top = this.vh < 500 ? 150 : 190; // below the top stack (track, combo, status chips, announcements)
    const py = Math.min(this.vh - 60, y - 70 >= top ? y - 70 : Math.max(top, y + 104));
    // A transform moves the layer on the compositor: no layout per frame.
    const tf = `translate3d(${Math.round(px)}px,${Math.round(py)}px,0)`;
    if (this._anchor === tf) return;
    if (!this._anchor) {
      st.left = '0px';
      st.top = '0px';
    }
    this._anchor = tf;
    st.transform = tf;
  }

  /* ---------------- events ---------------- */

  trickToast(label, points) {
    const toast = h('div', { class: 'trick', 'data-testid': 'trick-toast' }, h('span', { class: 'trick__label' }, label), points ? h('span', { class: 'trick__pts' }, `+${points}`) : null);
    // Older toasts drift up to make room.
    const live = [...this.toastLayer.children];
    if (live.length >= 3) live[0].remove();
    for (const t of this.toastLayer.children) t.style.setProperty('--lift', `${(parseFloat(t.style.getPropertyValue('--lift')) || 0) + 1}`);
    this.toastLayer.append(toast);
    setTimeout(() => toast.remove(), 1300);
  }

  comboBanked(total, mult, boostLevel) {
    const lvl = Math.max(0, Math.min(3, boostLevel | 0));
    const fly = h(
      'div',
      { class: 'banked', 'data-level': String(lvl), 'data-testid': 'combo-banked' },
      h('span', { class: 'banked__pts' }, `+${total}`),
      mult > 1 ? h('span', { class: 'banked__mult' }, `×${mult}`) : null,
      lvl ? h('span', { class: 'banked__boost' }, BOOST_NAMES[lvl]) : null
    );
    this.comboAnchor.append(fly);
    this.combo.classList.remove('is-on');
    this.cache.combo = '';
    replay(this.gauge, 'is-surge');
    setTimeout(() => fly.remove(), 1500);
  }

  announce(text, tone = 'info') {
    const pill = h('div', { class: `announce__pill announce__pill--${tone}` }, text);
    for (const old of this.announceEl.children) {
      old.classList.add('is-out');
      setTimeout(() => old.remove(), 300);
    }
    this.announceEl.append(pill);
    setTimeout(() => {
      pill.classList.add('is-out');
      setTimeout(() => pill.remove(), 400);
    }, 2600);
  }

  setCountdown(value) {
    if (this.cache.cd === value) return;
    this.cache.cd = value;
    const el = this.countdownEl;
    for (const old of el.children) {
      old.classList.add('is-out');
      setTimeout(() => old.remove(), 450);
    }
    clearTimeout(this._cdTimer);
    if (value === null || value === undefined) {
      this._cdTimer = setTimeout(() => (el.hidden = true), 450);
      if (!el.children.length) el.hidden = true;
      return;
    }
    el.hidden = false;
    const isGo = String(value).toUpperCase() === 'GO';
    el.dataset.value = String(value);
    const num = h('div', { class: `cd ${isGo ? 'cd--go' : ''}` }, h('span', { class: 'cd__ring', 'aria-hidden': 'true' }), h('span', { class: 'cd__num' }, isGo ? 'GO' : String(value)));
    el.append(num);
    if (isGo) this._cdTimer = setTimeout(() => this.setCountdown(null), 900);
  }

  setFinished(place, timeMs) {
    this.finishedPlace.replaceChildren(h('b', {}, String(place)), h('sup', {}, ordinalSuffix(place)));
    this.finishedTime.textContent = formatTime(timeMs);
    this.finishedEl.hidden = false;
    this.hud.classList.add('is-finished');
  }
}

const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0);
const ordinal = (n) => `${n}${ordinalSuffix(n)}`;
const formatClock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
