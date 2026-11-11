/**
 * Lobby: giant room code, share link + QR, live roster, race settings, start.
 * setLobby() is idempotent and diffed, so it can be called on every change.
 */
import { COURSE_LENGTHS, MAX_PLAYERS, PLAYER_COLORS, START_TIMES, WEATHERS } from '../contracts.js';
import { h, icon, replay } from './dom.js';
import { ICONS } from './icons.js';
import { formatTime, prettyUrl } from './format.js';
import { encodeQr, qrPath } from './qr.js';

/** Rough race durations shown under the course buttons (≈ 20 m/s average). */
export const COURSE_META = {
  sprint: { label: 'Sprint', minutes: '~1 min' },
  classic: { label: 'Classic', minutes: '~2 min' },
  marathon: { label: 'Marathon', minutes: '~3 min' },
};
const TIME_LABELS = { auto: 'Auto', dawn: 'Dawn', day: 'Day', golden: 'Golden', dusk: 'Dusk', night: 'Night' };
const WEATHER_LABELS = { auto: 'Auto', clear: 'Clear', snow: 'Snow', storm: 'Storm', fog: 'Fog' };
const MAX_BOTS = 6;

export class LobbyView {
  constructor(handlers) {
    this.handlers = handlers;
    this.view = null;
    this.rows = new Map(); // id → li
    this.qrFor = '';

    // --- invite card ---
    this.codeEl = h('p', { class: 'room-code', 'data-testid': 'room-code', 'aria-live': 'polite' });
    this.linkEl = h('span', { class: 'share__url', 'data-testid': 'share-link' });
    this.copyLabel = h('span', { class: 'btn__label' }, 'Copy');
    this.copyIcon = h('span', { class: 'swap' }, icon(ICONS.copy, 'icon icon--sm swap__a'), icon(ICONS.check, 'icon icon--sm swap__b'));
    this.copyBtn = h('button', { class: 'btn btn--chip', type: 'button', 'data-testid': 'copy-link', onclick: () => this._copy() }, this.copyIcon, this.copyLabel);
    this.shareBtn = h(
      'button',
      { class: 'btn btn--chip', type: 'button', 'data-testid': 'share-native', hidden: true, onclick: () => this._share() },
      icon(ICONS.share, 'icon icon--sm'),
      h('span', { class: 'btn__label' }, 'Share')
    );
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function' && matchMedia('(pointer: coarse)').matches) this.shareBtn.hidden = false;
    this.qrEl = h('div', { class: 'qr', 'data-testid': 'qr-code', role: 'img', 'aria-label': 'QR code of the invite link' });

    const invite = h(
      'div',
      { class: 'glass lobby__invite reveal', style: { '--d': '0ms' } },
      h('p', { class: 'eyebrow' }, 'Room code'),
      this.codeEl,
      h('p', { class: 'lobby__invite-hint' }, 'Friends join with this code, the link, or by scanning.'),
      h('div', { class: 'share' }, this.linkEl, h('div', { class: 'share__actions' }, this.copyBtn, this.shareBtn)),
      h('div', { class: 'qr-wrap' }, this.qrEl, h('p', { class: 'qr-caption' }, h('span', { class: 'eyebrow' }, 'Scan to join'), h('span', {}, 'Point a phone camera here.')))
    );

    // --- your scarf colour (taken colours are locked) ---
    this.swatches = PLAYER_COLORS.map((color, i) =>
      h(
        'button',
        {
          class: 'swatch',
          type: 'button',
          role: 'radio',
          'aria-checked': 'false',
          'aria-label': `Colour ${i + 1}`,
          style: { '--c': color },
          'data-testid': `lobby-swatch-${i}`,
          onclick: () => this.handlers.onProfileChange?.({ name: this.view?.selfName ?? '', colorIndex: i }),
        },
        h('span', { class: 'swatch__lock', 'aria-hidden': 'true' })
      )
    );
    this.swatchRow = h('div', { class: 'lobby__scarf' }, h('span', { class: 'setting__label' }, 'Your scarf'), h('div', { class: 'swatches swatches--small', role: 'radiogroup', 'aria-label': 'Scarf colour' }, this.swatches));

    // --- roster ---
    this.countEl = h('span', { class: 'count', 'data-testid': 'player-count' });
    this.list = h('ul', { class: 'players', 'data-testid': 'player-list', 'aria-label': 'Riders in the room' });
    this.botsNote = h('p', { class: 'bots-note', 'data-testid': 'bots-note', hidden: true });

    // --- settings ---
    this.hostNote = h('span', { class: 'settings__note', 'data-testid': 'settings-note' });
    this.groups = {
      length: this._segmented(
        'length',
        'Course',
        Object.keys(COURSE_LENGTHS).map((k) => ({ value: k, label: COURSE_META[k]?.label || k, meta: `${(COURSE_LENGTHS[k] / 1000).toFixed(1)} km · ${COURSE_META[k]?.minutes || ''}` }))
      ),
      startTime: this._segmented('startTime', 'Time', START_TIMES.map((k) => ({ value: k, label: TIME_LABELS[k] || k })), 'time'),
      weather: this._segmented('weather', 'Weather', WEATHERS.map((k) => ({ value: k, label: WEATHER_LABELS[k] || k }))),
      catchUp: this._segmented('catchUp', 'Catch-up', [
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ]),
    };
    // RaceSettings.catchUp is a boolean; the segmented control speaks 'on' / 'off'
    this.groups.catchUp.toSetting = (v) => v === 'on';
    this.groups.catchUp.el.title = 'Riders far behind get a small speed bonus';
    this.botsValue = h('output', { class: 'stepper__value', 'data-testid': 'setting-bots-value', 'aria-live': 'polite' }, '0');
    this.botsMinus = h('button', { class: 'stepper__btn', type: 'button', 'aria-label': 'Fewer bots', 'data-testid': 'setting-bots-minus', onclick: () => this._bots(-1) }, icon(ICONS.minus, 'icon icon--sm'));
    this.botsPlus = h('button', { class: 'stepper__btn', type: 'button', 'aria-label': 'More bots', 'data-testid': 'setting-bots-plus', onclick: () => this._bots(1) }, icon(ICONS.plus, 'icon icon--sm'));
    const botsRow = h(
      'div',
      { class: 'setting setting--bots' },
      h('span', { class: 'setting__label', id: 'lbl-bots' }, 'Bots'),
      h('div', { class: 'stepper', role: 'group', 'aria-labelledby': 'lbl-bots' }, this.botsMinus, this.botsValue, this.botsPlus)
    );
    this.settingsEl = h(
      'div',
      { class: 'settings', 'data-testid': 'settings' },
      h('div', { class: 'section-head' }, h('h3', { class: 'section-title' }, 'Race'), this.hostNote),
      this.groups.length.el,
      this.groups.startTime.el,
      this.groups.weather.el,
      this.groups.catchUp.el,
      botsRow
    );

    // --- call to action ---
    this.startBtn = h('button', { class: 'btn btn--primary btn--start', type: 'button', 'data-testid': 'start-race', onclick: () => this.view?.canStart && this.handlers.onStart?.() }, h('span', { class: 'btn__label' }, 'Start race'), icon(ICONS.play, 'icon icon--sm'));
    this.startHint = h('p', { class: 'start-hint', 'data-testid': 'start-hint' });
    this.waiting = h('p', { class: 'waiting', 'data-testid': 'waiting-host' }, h('span', { class: 'waiting__text' }), h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
    this.cta = h('div', { class: 'lobby__cta' }, this.startBtn, this.startHint, this.waiting);

    // --- joined mid-race: live mini-standings ---
    this.liveRows = new Map();
    this.liveList = h('ol', { class: 'live__list', 'data-testid': 'live-standings' });
    this.liveEl = h(
      'div',
      { class: 'live', hidden: true, 'data-testid': 'race-in-progress' },
      h('div', { class: 'section-head' }, h('h3', { class: 'section-title' }, h('span', { class: 'live__dot', 'aria-hidden': 'true' }), 'Race in progress'), h('span', { class: 'settings__note' }, "you're in the next one")),
      this.liveList
    );

    const main = h(
      'div',
      { class: 'glass lobby__main reveal', style: { '--d': '90ms' } },
      h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Riders'), this.countEl),
      this.list,
      this.botsNote,
      this.swatchRow,
      this.liveEl,
      this.settingsEl,
      this.cta
    );

    this.leaveBtn = h('button', { class: 'btn btn--ghost btn--back', type: 'button', 'data-testid': 'leave-room', onclick: () => this.handlers.onLeave?.() }, icon(ICONS.back, 'icon icon--sm'), h('span', { class: 'btn__label' }, 'Leave'));

    this.el = h(
      'section',
      { class: 'screen screen--lobby', 'data-screen': 'lobby', 'aria-label': 'Lobby', hidden: true },
      h('div', { class: 'screen__top' }, this.leaveBtn),
      h('div', { class: 'lobby__grid' }, invite, main)
    );
  }

  /* ---------------- public ---------------- */

  /** @param {{code:string, shareUrl:string, players:Array, selfId:string, isHost:boolean, settings:Object, canStart:boolean, startHint?:string}} view */
  setLobby(view) {
    if (!view) return;
    this.view = view;
    const code = String(view.code || '');
    if (this.codeEl.textContent !== code) this.codeEl.textContent = code;
    const pretty = prettyUrl(view.shareUrl);
    if (this.linkEl.textContent !== pretty) {
      this.linkEl.textContent = pretty;
      this.linkEl.title = view.shareUrl || '';
    }
    if (view.shareUrl && view.shareUrl !== this.qrFor) this._renderQr(view.shareUrl);

    this._renderPlayers(view.players || [], view.selfId);

    const s = view.settings || {};
    this.el.classList.toggle('is-host', !!view.isHost);
    for (const [key, g] of Object.entries(this.groups)) g.set(key === 'catchUp' ? (s.catchUp === false ? 'off' : 'on') : s[key], !view.isHost);
    this._renderSwatches(view);
    const bots = Math.max(0, Math.min(MAX_BOTS, s.bots | 0));
    this.botsValue.textContent = String(bots);
    this.botsMinus.disabled = !view.isHost || bots <= 0;
    this.botsPlus.disabled = !view.isHost || bots >= MAX_BOTS;
    this.botsNote.hidden = bots === 0;
    this.botsNote.textContent = bots === 0 ? '' : `+ ${bots} bot${bots === 1 ? '' : 's'} will race too`;
    this.settingsEl.classList.toggle('is-readonly', !view.isHost);
    this.hostNote.textContent = view.isHost ? 'You choose' : 'Host is choosing…';

    this.startBtn.hidden = !view.isHost;
    this.startBtn.disabled = !view.canStart;
    this.startHint.hidden = !view.isHost || !!view.canStart;
    this.startHint.textContent = view.isHost && !view.canStart ? view.startHint || defaultStartHint(view) : '';
    this.waiting.hidden = !!view.isHost;
    const host = (view.players || []).find((p) => p.isHost);
    this.waiting.firstChild.textContent = view.inProgress ? "A race is on. You're in the next one" : host ? `Waiting for ${host.name} to start` : 'Waiting for the host to start';
    this._renderLive(view.inProgress ? view.live : null);
  }

  /** @param {Array<{id:string,name:string,color:string,progress:number,finished:boolean,timeMs?:number}>|null} rows */
  _renderLive(rows) {
    this.liveEl.hidden = !rows || !rows.length;
    if (this.liveEl.hidden) {
      if (this.liveRows.size) {
        this.liveList.replaceChildren();
        this.liveRows.clear();
      }
      return;
    }
    const seen = new Set();
    rows.forEach((r, i) => {
      seen.add(r.id);
      let row = this.liveRows.get(r.id);
      if (!row) {
        const fill = h('span', { class: 'live__fill' });
        const meta = h('span', { class: 'live__meta' });
        const name = h('span', { class: 'live__name' });
        row = { el: h('li', { class: 'live__row' }, h('span', { class: 'avatar avatar--sm' }, h('span', { class: 'avatar__scarf' })), name, h('span', { class: 'live__bar' }, fill), meta), fill, meta, name, key: '' };
        this.liveRows.set(r.id, row);
      }
      const p = Math.round(Math.max(0, Math.min(1, r.progress)) * 100);
      const key = `${r.name}|${r.color}|${p}|${r.finished}|${r.timeMs}`;
      if (row.key !== key) {
        row.key = key;
        row.el.style.setProperty('--c', r.color);
        row.name.textContent = r.name;
        row.fill.style.transform = `scaleX(${p / 100})`;
        row.meta.textContent = r.finished ? (r.timeMs >= 0 ? formatTime(r.timeMs) : 'done') : `${p}%`;
        row.el.classList.toggle('is-done', !!r.finished);
      }
      if (this.liveList.children[i] !== row.el) this.liveList.insertBefore(row.el, this.liveList.children[i] || null);
    });
    for (const [id, row] of this.liveRows) {
      if (!seen.has(id)) {
        row.el.remove();
        this.liveRows.delete(id);
      }
    }
  }

  /* ---------------- internals ---------------- */

  _renderSwatches(view) {
    const players = view.players || [];
    const me = players.find((p) => p.id === view.selfId);
    const mine = me ? me.colorIndex : -1;
    const taken = new Set(view.takenColors ?? players.filter((p) => p.id !== view.selfId && p.connected !== false).map((p) => p.colorIndex));
    this.view.selfName = me?.name ?? '';
    this.swatches.forEach((b, i) => {
      const isMine = i === mine;
      const locked = taken.has(i) && !isMine;
      b.setAttribute('aria-checked', String(isMine));
      b.disabled = locked;
      b.classList.toggle('is-taken', locked);
      b.title = locked ? 'Taken' : '';
    });
  }

  _renderPlayers(players, selfId) {
    const seen = new Set();
    const ordered = [];
    for (const p of players) {
      seen.add(p.id);
      let li = this.rows.get(p.id);
      if (!li) {
        li = this._createRow(p.id);
        this.rows.set(p.id, li);
        if (this.view && this._painted) li.classList.add('is-new');
      }
      if (li.classList.contains('is-leaving')) li.classList.remove('is-leaving');
      this._updateRow(li, p, p.id === selfId);
      ordered.push(li);
    }
    for (const [id, li] of this.rows) {
      if (seen.has(id) || li.classList.contains('is-leaving')) continue;
      li.classList.add('is-leaving');
      setTimeout(() => {
        if (li.classList.contains('is-leaving')) {
          li.remove();
          this.rows.delete(id);
          this._renderEmpty();
        }
      }, 340);
    }
    // Keep leaving rows where they are (they fade out), then empty slots.
    const leaving = [...this.rows.values()].filter((li) => li.classList.contains('is-leaving'));
    const desired = [...ordered, ...leaving];
    desired.forEach((li, i) => {
      if (this.list.children[i] !== li) this.list.insertBefore(li, this.list.children[i] || null);
    });
    this._renderEmpty();
    this.countEl.textContent = `${players.length}/${MAX_PLAYERS}`;
    this._painted = true;
  }

  _renderEmpty() {
    const real = [...this.list.children].filter((li) => !li.classList.contains('player--empty')).length;
    // Hint a few open slots (never a wall of 12): fill the row, plus one more row, at least 6 in total.
    const visible = Math.min(MAX_PLAYERS, Math.max(6, Math.ceil((real + 2) / 2) * 2));
    const want = Math.max(0, visible - real);
    let empties = [...this.list.querySelectorAll('.player--empty')];
    while (empties.length > want) empties.pop().remove();
    while (empties.length < want) {
      const li = h('li', { class: 'player player--empty', 'aria-hidden': 'true' }, h('span', { class: 'avatar avatar--empty' }), h('span', { class: 'player__name' }, 'Open'));
      this.list.append(li);
      empties.push(li);
    }
    // empties always at the end
    for (const li of empties) if (li.nextElementSibling && !li.nextElementSibling.classList.contains('player--empty')) this.list.append(li);
  }

  _createRow(id) {
    const li = h(
      'li',
      { class: 'player', 'data-testid': 'player-row', 'data-player-id': id },
      h('span', { class: 'avatar' }, h('span', { class: 'avatar__scarf' })),
      h('span', { class: 'player__name' }),
      h('span', { class: 'player__tags' }),
      h(
        'button',
        { class: 'player__remove', type: 'button', hidden: true, 'data-testid': 'remove-player', 'aria-label': 'Remove from the room', title: 'Remove', onclick: () => this.handlers.onRemovePlayer?.(id, li.querySelector('.player__name').textContent) },
        icon(ICONS.remove, 'icon icon--sm')
      )
    );
    li.addEventListener('animationend', () => li.classList.remove('is-new'));
    return li;
  }

  _updateRow(li, p, isSelf) {
    li.querySelector('.player__remove').hidden = !this.view?.isHost || isSelf;
    const key = `${p.name}|${p.colorIndex}|${p.isHost}|${p.connected}|${p.ready}|${isSelf}`;
    if (li.__key === key) return;
    li.__key = key;
    li.style.setProperty('--c', PLAYER_COLORS[p.colorIndex] || PLAYER_COLORS[0]);
    li.querySelector('.player__name').textContent = p.name;
    li.classList.toggle('is-self', isSelf);
    li.classList.toggle('is-away', p.connected === false);
    li.classList.toggle('is-busy', p.connected !== false && p.ready === false);
    const tags = li.querySelector('.player__tags');
    tags.replaceChildren();
    if (p.isHost) tags.append(h('span', { class: 'tag tag--host', title: 'Host', 'data-testid': 'host-badge' }, icon(ICONS.crown, 'icon icon--xs'), h('span', { class: 'sr-only' }, 'Host')));
    if (isSelf) tags.append(h('span', { class: 'tag tag--you', 'data-testid': 'you-badge' }, 'you'));
    if (p.connected === false) tags.append(h('span', { class: 'tag tag--muted' }, 'reconnecting'));
    else if (p.ready === false) tags.append(h('span', { class: 'tag tag--muted' }, 'on results'));
  }

  _segmented(key, label, options, idKey = key) {
    const id = `lbl-${key}`;
    const buttons = options.map((o) =>
      h(
        'button',
        {
          class: 'seg__opt',
          type: 'button',
          role: 'radio',
          'aria-checked': 'false',
          'data-value': o.value,
          'data-testid': `setting-${idKey}-${o.value}`,
          onclick: () => {
            if (!this.view?.isHost) return;
            g.set(o.value, false); // optimistic; setLobby() is authoritative
            this.handlers.onSettings?.({ [key]: g.toSetting ? g.toSetting(o.value) : o.value });
          },
        },
        h('span', { class: 'seg__label' }, o.label),
        o.meta ? h('span', { class: 'seg__meta' }, o.meta) : null
      )
    );
    const group = h('div', { class: `seg seg--${key}`, role: 'radiogroup', 'aria-labelledby': id, style: { '--n': options.length } }, h('span', { class: 'seg__thumb', 'aria-hidden': 'true' }), buttons);
    const el = h('div', { class: 'setting' }, h('span', { class: 'setting__label', id }, label), group);
    const g = {
      el,
      value: null,
      set: (value, readonly) => {
        const idx = Math.max(0, options.findIndex((o) => o.value === value));
        if (g.value !== value) {
          g.value = value;
          buttons.forEach((b, i) => b.setAttribute('aria-checked', String(i === idx)));
          group.style.setProperty('--i', idx);
          group.style.setProperty('--col', idx % 3);
          group.style.setProperty('--row', Math.floor(idx / 3));
        }
        g.readonly = readonly;
        buttons.forEach((b, i) => {
          // Read-only: the chosen option stays readable (not greyed); the others are inert.
          b.disabled = readonly && i !== idx;
          b.setAttribute('aria-disabled', String(readonly));
          b.tabIndex = readonly ? -1 : 0;
        });
      },
    };
    return g;
  }

  _bots(delta) {
    if (!this.view?.isHost) return;
    const cur = this.view.settings?.bots | 0;
    const next = Math.max(0, Math.min(MAX_BOTS, cur + delta));
    if (next === cur) return;
    this.view = { ...this.view, settings: { ...this.view.settings, bots: next } };
    this.botsValue.textContent = String(next);
    replay(this.botsValue, 'tick');
    this.botsMinus.disabled = next <= 0;
    this.botsPlus.disabled = next >= MAX_BOTS;
    this.handlers.onSettings?.({ bots: next });
  }

  _renderQr(url) {
    this.qrFor = url;
    try {
      const qr = encodeQr(url, { ecl: 'M' });
      const margin = 0;
      const n = qr.size + margin * 2;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
      svg.setAttribute('shape-rendering', 'crispEdges');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', qrPath(qr, margin));
      path.setAttribute('fill', 'currentColor');
      svg.append(path);
      this.qrEl.replaceChildren(svg);
    } catch {
      this.qrEl.replaceChildren();
    }
  }

  async _copy() {
    const url = this.view?.shareUrl || '';
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      ok = legacyCopy(url);
    }
    this.handlers.onCopyLink?.();
    this.copyBtn.classList.toggle('is-done', ok);
    this.copyLabel.textContent = ok ? 'Copied' : 'Press Ctrl+C';
    if (!ok) selectText(this.linkEl);
    clearTimeout(this._copyTimer);
    this._copyTimer = setTimeout(() => {
      this.copyBtn.classList.remove('is-done');
      this.copyLabel.textContent = 'Copy';
    }, 1800);
  }

  async _share() {
    const v = this.view;
    if (!v) return;
    try {
      await navigator.share({ title: 'Snowline', text: `Race me on Snowline. Room ${v.code}`, url: v.shareUrl });
    } catch {
      /* cancelled */
    }
  }
}

function defaultStartHint(view) {
  const players = view.players || [];
  if (players.length < 2 && !(view.settings?.bots > 0)) return 'Invite a friend or add a bot to start';
  if (players.some((p) => p.ready === false)) return 'Waiting for riders still on the results screen';
  return 'Getting everyone ready…';
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

function selectText(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
