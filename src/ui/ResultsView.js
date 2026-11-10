/**
 * Results: winner hero, animated podium, full ranking, save state, actions.
 */
import { COURSE_LENGTHS, PLAYER_COLORS } from '../contracts.js';
import { h, icon } from './dom.js';
import { ICONS, RIDER_SVG } from './icons.js';
import { formatGap, formatTime, ordinal, ordinalSuffix } from './format.js';
import { COURSE_META } from './LobbyView.js';

const SAVE_TEXT = { pending: 'Saving to Hall of Fame…', ok: 'Saved to Hall of Fame', local: 'Saved on this device' };

export class ResultsView {
  constructor(handlers) {
    this.handlers = handlers;

    this.metaEl = h('p', { class: 'eyebrow results__meta', 'data-testid': 'results-meta' });
    this.winnerEl = h('h2', { class: 'results__winner', 'data-testid': 'results-winner' });
    this.winTimeEl = h('p', { class: 'results__time' });
    this.podium = h('div', { class: 'podium', 'data-testid': 'podium' });
    const hero = h('div', { class: 'results__hero reveal', style: { '--d': '0ms' } }, this.metaEl, this.winnerEl, this.winTimeEl, this.podium);

    this.saveEl = h('span', { class: 'chip', 'data-testid': 'save-status' });
    this.list = h('ol', { class: 'ranking', 'data-testid': 'results-list' });
    const head = h(
      'div',
      { class: 'ranking__head', 'aria-hidden': 'true' },
      h('span', { class: 'c-place' }, '#'),
      h('span', { class: 'c-name' }, 'Rider'),
      h('span', { class: 'c-time' }, 'Time'),
      h('span', { class: 'c-gap' }, 'Gap'),
      h('span', { class: 'c-score' }, 'Score'),
      h('span', { class: 'c-combo' }, 'Best combo')
    );

    this.againBtn = h('button', { class: 'btn btn--primary', type: 'button', 'data-testid': 'play-again', onclick: () => this.handlers.onPlayAgain?.() }, h('span', { class: 'btn__label' }, 'Race again'));
    this.backBtn = h('button', { class: 'btn btn--primary', type: 'button', 'data-testid': 'back-to-lobby', onclick: () => this.handlers.onBackToLobby?.() }, h('span', { class: 'btn__label' }, 'Back to lobby'));
    this.fameBtn = h('button', { class: 'btn btn--ghost', type: 'button', 'data-testid': 'results-hall-of-fame', onclick: () => this.handlers.openFame() }, icon(ICONS.trophy, 'icon icon--sm'), h('span', { class: 'btn__label' }, 'Hall of fame'));
    this.leaveBtn = h('button', { class: 'btn btn--ghost', type: 'button', 'data-testid': 'results-leave', onclick: () => this.handlers.onLeave?.() }, h('span', { class: 'btn__label' }, 'Leave'));

    const card = h(
      'div',
      { class: 'glass results__card reveal', style: { '--d': '140ms' } },
      h('div', { class: 'section-head' }, h('h3', { class: 'section-title' }, 'Ranking'), this.saveEl),
      head,
      this.list,
      h('div', { class: 'results__actions' }, this.againBtn, this.backBtn, this.fameBtn, this.leaveBtn)
    );

    this.el = h('section', { class: 'screen screen--results', 'data-screen': 'results', 'aria-label': 'Results', hidden: true }, h('div', { class: 'results__grid' }, hero, card));
  }

  setResults({ results, selfId, isHost, saved }) {
    const ranking = results?.ranking || [];
    const settings = results?.settings || {};
    const winner = ranking[0];
    const winnerTime = winner && winner.timeMs >= 0 ? winner.timeMs : -1;

    const len = COURSE_META[settings.length]?.label || settings.length || '';
    const km = COURSE_LENGTHS[settings.length] ? `${(COURSE_LENGTHS[settings.length] / 1000).toFixed(1)} km` : '';
    this.metaEl.textContent = [len, km, `${ranking.length} rider${ranking.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ');

    if (winnerTime >= 0) {
      const self = winner.id === selfId;
      this.winnerEl.replaceChildren(h('span', { class: 'results__name' }, self ? 'You' : winner.name), h('span', { class: 'results__verb' }, self ? ' win' : ' wins'));
      this.winnerEl.style.setProperty('--c', PLAYER_COLORS[winner.colorIndex] || PLAYER_COLORS[0]);
      this.winTimeEl.textContent = formatTime(winnerTime);
    } else {
      this.winnerEl.replaceChildren(h('span', { class: 'results__name' }, 'No finishers'));
      this.winTimeEl.textContent = 'The mountain wins this time';
    }

    // podium: 2nd, 1st, 3rd
    const finishers = ranking.filter((r) => r.timeMs >= 0).slice(0, 3);
    const order = [1, 0, 2].filter((i) => finishers[i]);
    this.podium.replaceChildren(
      ...order.map((i) => {
        const r = finishers[i];
        const rider = icon(RIDER_SVG, 'rider');
        return h(
          'div',
          { class: `podium__step podium__step--${i + 1} ${r.id === selfId ? 'is-self' : ''}`, style: { '--c': PLAYER_COLORS[r.colorIndex] || PLAYER_COLORS[0], '--scarf': PLAYER_COLORS[r.colorIndex] || PLAYER_COLORS[0] }, 'data-testid': `podium-${i + 1}` },
          h('span', { class: 'podium__rider' }, rider),
          h('span', { class: 'podium__name' }, r.name),
          h('span', { class: 'podium__time' }, formatTime(r.timeMs)),
          h('span', { class: 'podium__block' }, h('span', { class: 'podium__place' }, String(i + 1), h('sup', {}, ordinalSuffix(i + 1))))
        );
      })
    );
    this.podium.classList.toggle('is-empty', finishers.length === 0);

    // ranking
    let place = 0;
    this.list.replaceChildren(
      ...ranking.map((r, i) => {
        const dnf = !(r.timeMs >= 0);
        if (!dnf) place++;
        const self = r.id === selfId;
        const gap = !dnf && winnerTime >= 0 && i > 0 ? formatGap(r.timeMs - winnerTime) : '';
        return h(
          'li',
          { class: `row ${self ? 'is-self' : ''} ${dnf ? 'is-dnf' : ''}`, 'data-testid': 'result-row', 'data-player-id': r.id, style: { '--c': PLAYER_COLORS[r.colorIndex] || PLAYER_COLORS[0], '--i': i } },
          h('span', { class: 'c-place' }, dnf ? '—' : ordinal(place)),
          h('span', { class: 'c-name' }, h('span', { class: 'avatar avatar--sm' }, h('span', { class: 'avatar__scarf' })), h('span', { class: 'row__name' }, r.name), self ? h('span', { class: 'tag tag--you' }, 'you') : null),
          h('span', { class: 'c-time' }, dnf ? h('span', { class: 'dnf' }, `DNF · ${Math.round((r.progress || 0) * 100)}%`) : formatTime(r.timeMs)),
          h('span', { class: 'c-gap' }, gap),
          h('span', { class: 'c-score' }, String(r.stats?.score ?? 0)),
          h('span', { class: 'c-combo' }, String(r.stats?.bestCombo ?? 0))
        );
      })
    );

    this.saveEl.textContent = SAVE_TEXT[saved] || '';
    this.saveEl.dataset.state = saved || '';
    this.saveEl.hidden = !SAVE_TEXT[saved] || winnerTime < 0;

    this.againBtn.hidden = !isHost;
    this.backBtn.hidden = !!isHost;
  }
}
