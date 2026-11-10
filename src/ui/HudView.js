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

export class HudView {
  constructor() {
    this.cache = {};
    this.markers = new Map();
    this.ringMax = { hover: 0, magnet: 0 };

    // top-left: time + position
    this.timeEl = h('span', { class: 'hud-time', 'data-testid': 'hud-timer', 'aria-label': 'Race time' }, '0:00.00');
    this.posEl = h('b', {}, '–');
    this.totalEl = h('span', {}, '/–');
    this.posWrap = h('span', { class: 'hud-pos', 'data-testid': 'hud-position', 'aria-label': 'Position' }, this.posEl, this.totalEl);
    const tl = h('div', { class: 'hud__tl' }, this.timeEl, this.posWrap);

    // top-centre: progress track + combo readout
    this.fill = h('span', { class: 'track__fill' });
    this.markerLayer = h('span', { class: 'track__markers' });
    this.track = h(
      'div',
      { class: 'track', 'data-testid': 'hud-progress', role: 'progressbar', 'aria-label': 'Course progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' },
      h('span', { class: 'track__line' }),
      this.fill,
      this.markerLayer,
      h('span', { class: 'track__flag' }, icon(ICONS.flag, 'icon icon--xs'))
    );
    this.comboTricks = h('span', { class: 'combo__tricks' });
    this.comboMult = h('span', { class: 'combo__mult' });
    this.comboPts = h('span', { class: 'combo__pts' });
    this.combo = h('div', { class: 'combo', 'data-testid': 'hud-combo', 'aria-live': 'off' }, this.comboTricks, this.comboMult, this.comboPts);
    this.comboAnchor = h('div', { class: 'combo-anchor' }, this.combo);
    const top = h('div', { class: 'hud__top' }, this.track, this.comboAnchor);

    // bottom-left: speed, scarf gauge, power-ups
    this.speedEl = h('b', {}, '0');
    const speed = h('span', { class: 'hud-speed', 'data-testid': 'hud-speed' }, this.speedEl, h('small', {}, 'km/h'));
    this.gaugeFill = h('span', { class: 'gauge__fill' });
    this.gaugeBoost = h('span', { class: 'gauge__boost' });
    this.gauge = h('span', { class: 'gauge', 'data-testid': 'hud-scarf', role: 'meter', 'aria-label': 'Scarf', 'aria-valuemin': '0', 'aria-valuemax': '100' }, this.gaugeFill, this.gaugeBoost);
    this.boostTag = h('span', { class: 'gauge__tag', 'data-testid': 'hud-boost' });
    this.rings = { hover: this._ring('hover', ICONS.feather, 'Feather'), magnet: this._ring('magnet', ICONS.magnet, 'Magnet') };
    const bl = h('div', { class: 'hud__bl' }, h('div', { class: 'hud__meter' }, speed, h('span', { class: 'gauge-wrap' }, this.gauge, this.boostTag)), h('div', { class: 'rings' }, this.rings.hover.el, this.rings.magnet.el));

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

    this.hud = h('div', { class: 'hud', 'data-testid': 'hud' }, tl, top, bl);
    this.el = h('section', { class: 'screen screen--race', 'data-screen': 'race', 'aria-label': 'Race', hidden: true }, this.hud, this.toastLayer, this.announceEl, this.countdownEl, this.finishedEl);
  }

  /** Clears per-race state (called when a race screen is entered fresh). */
  reset() {
    this.cache = { cd: this.cache.cd };
    this.ringMax = { hover: 0, magnet: 0 };
    for (const m of this.markers.values()) m.el.remove();
    this.markers.clear();
    this.toastLayer.replaceChildren();
    this.announceEl.replaceChildren();
    this.finishedEl.hidden = true;
    this.hud.classList.remove('is-finished');
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

    // speed
    setText(this.speedEl, Math.max(0, Math.round((hud.speedMps || 0) * 3.6)));

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
    this.comboTricks.textContent = shown.join(' · ');
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
      return;
    }
    // keep a little above the rider and inside the viewport
    const px = Math.max(90, Math.min(innerWidth - 90, x));
    const py = Math.max(140, Math.min(innerHeight - 60, y - 70));
    const l = `${Math.round(px)}px`;
    const t = `${Math.round(py)}px`;
    if (st.left !== l) st.left = l;
    if (st.top !== t) st.top = t;
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
