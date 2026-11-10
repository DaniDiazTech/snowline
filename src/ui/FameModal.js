/**
 * Hall of fame dialog: recent winners, or the fastest per course length.
 */
import { PLAYER_COLORS } from '../contracts.js';
import { h, icon } from './dom.js';
import { ICONS } from './icons.js';
import { formatTime, relativeTime } from './format.js';
import { COURSE_META } from './LobbyView.js';

const TABS = [
  { key: 'recent', label: 'Recent' },
  { key: 'sprint', label: 'Sprint' },
  { key: 'classic', label: 'Classic' },
  { key: 'marathon', label: 'Marathon' },
];

export class FameModal {
  constructor(handlers) {
    this.handlers = handlers;
    this.records = null;
    this.tab = 'recent';
    this.open = false;

    this.tabs = TABS.map((t) =>
      h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': 'false', 'data-testid': `fame-tab-${t.key}`, onclick: () => this._setTab(t.key) }, t.label)
    );
    this.list = h('ol', { class: 'fame', 'data-testid': 'fame-list', 'aria-busy': 'true' });
    this.closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', 'data-testid': 'fame-close', onclick: () => this.close() }, icon(ICONS.close));
    this.panel = h(
      'div',
      { class: 'glass glass--strong modal__panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fame-title', tabindex: '-1' },
      h(
        'header',
        { class: 'modal__head' },
        h('div', {}, h('p', { class: 'eyebrow' }, 'Winners'), h('h2', { class: 'modal__title', id: 'fame-title' }, 'Hall of fame')),
        this.closeBtn
      ),
      h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Filter' }, this.tabs),
      h('div', { class: 'modal__body' }, this.list)
    );
    this.el = h('div', { class: 'modal', 'data-testid': 'fame-modal', hidden: true }, h('div', { class: 'modal__scrim', onclick: () => this.close() }), this.panel);
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      } else if (e.key === 'Tab') this._trap(e);
    });
    this._setTab('recent');
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.returnFocus = document.activeElement;
    this.el.hidden = false;
    void this.el.offsetWidth;
    this.el.classList.add('is-open');
    this.closeBtn.focus({ preventScroll: true });
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.el.classList.remove('is-open');
    setTimeout(() => {
      if (!this.open) this.el.hidden = true;
    }, 320);
    this.returnFocus?.focus?.({ preventScroll: true });
  }

  setRecords(records) {
    this.records = records;
    this._render();
  }

  _setTab(key) {
    this.tab = key;
    this.tabs.forEach((b, i) => b.setAttribute('aria-selected', String(TABS[i].key === key)));
    this._render();
  }

  _render() {
    const recs = this.records;
    this.list.setAttribute('aria-busy', String(recs === null));
    if (recs === null) {
      this.list.replaceChildren(...Array.from({ length: 5 }, (_, i) => h('li', { class: 'fame__row fame__row--skeleton', style: { '--i': i } }, h('span', { class: 'sk sk--dot' }), h('span', { class: 'sk sk--line' }), h('span', { class: 'sk sk--short' }))));
      return;
    }
    let rows = recs.slice();
    if (this.tab !== 'recent') rows = rows.filter((r) => r.length === this.tab).sort((a, b) => a.timeMs - b.timeMs);
    if (!rows.length) {
      this.list.replaceChildren(
        h('li', { class: 'fame__empty', 'data-testid': 'fame-empty' }, icon(ICONS.trophy, 'icon icon--lg'), h('p', {}, this.tab === 'recent' ? 'No winners yet.' : `No ${COURSE_META[this.tab]?.label || this.tab} winners yet.`), h('p', { class: 'muted' }, 'Win a race and your name lives here.'))
      );
      return;
    }
    const ranked = this.tab !== 'recent';
    this.list.replaceChildren(
      ...rows.slice(0, 50).map((r, i) =>
        h(
          'li',
          { class: `fame__row ${ranked && i < 3 ? `is-top is-top-${i + 1}` : ''}`, 'data-testid': 'fame-row', style: { '--c': PLAYER_COLORS[r.colorIndex] || PLAYER_COLORS[0], '--i': Math.min(i, 12) } },
          h('span', { class: 'fame__rank' }, ranked ? String(i + 1) : ''),
          h('span', { class: 'avatar avatar--sm' }, h('span', { class: 'avatar__scarf' })),
          h(
            'span',
            { class: 'fame__who' },
            h('span', { class: 'fame__name' }, r.name),
            h('span', { class: 'fame__meta' }, [COURSE_META[r.length]?.label || r.length, `${r.players} rider${r.players === 1 ? '' : 's'}`, relativeTime(r.at)].filter(Boolean).join(' · '))
          ),
          h('span', { class: 'fame__nums' }, h('span', { class: 'fame__time' }, formatTime(r.timeMs)), h('span', { class: 'fame__score' }, `${r.score ?? 0} pts`))
        )
      )
    );
  }

  _trap(e) {
    const f = [...this.panel.querySelectorAll('button:not([disabled])')];
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
