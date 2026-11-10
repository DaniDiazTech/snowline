/**
 * Static inline SVG icons (thin strokes, currentColor). Parsed by dom.icon().
 * Never interpolate user data into these strings.
 */
const s = (body, vb = '0 0 24 24') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  emblem: s(
    '<circle cx="31" cy="12.5" r="5.2"/><path d="M2 30 L15.5 13.5 L21 19.5 L27.5 12 L46 30" /><path d="M11.4 18.6 L15.5 16.8 L18.6 19.4" stroke-width="1.2"/>',
    '0 0 48 32'
  ),
  crown: s('<path d="M4.5 17.5 L3.5 8.5 L8.5 12 L12 5.5 L15.5 12 L20.5 8.5 L19.5 17.5 Z"/><path d="M5 20.5 H19"/>'),
  copy: s('<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 5.5 V5 A1.5 1.5 0 0 0 14 3.5 H6 A2.5 2.5 0 0 0 3.5 6 V14 A1.5 1.5 0 0 0 5 15.5 H5.5"/>'),
  check: s('<path d="M5 12.5 L10 17 L19 7.5"/>'),
  share: s('<path d="M12 3.5 V14.5"/><path d="M7.5 8 L12 3.5 L16.5 8"/><path d="M8 11 H6.5 A2 2 0 0 0 4.5 13 V18.5 A2 2 0 0 0 6.5 20.5 H17.5 A2 2 0 0 0 19.5 18.5 V13 A2 2 0 0 0 17.5 11 H16"/>'),
  soundOn: s('<path d="M4 9.5 H7.5 L12 5.5 V18.5 L7.5 14.5 H4 Z"/><path d="M15.5 9 A4 4 0 0 1 15.5 15"/><path d="M18 6.5 A7.5 7.5 0 0 1 18 17.5"/>'),
  soundOff: s('<path d="M4 9.5 H7.5 L12 5.5 V18.5 L7.5 14.5 H4 Z"/><path d="M16 9.5 L21 14.5 M21 9.5 L16 14.5"/>'),
  flag: s('<path d="M6 21 V3.5"/><path d="M6 4 H17 L14.5 7.5 L17 11 H6"/>'),
  feather: s('<path d="M19.5 4.5 C12 4.5 6.5 10 6.5 17.5 L4.5 19.5"/><path d="M19.5 4.5 C19.5 12 14 17.5 6.5 17.5"/><path d="M6.5 17.5 L14 10"/>'),
  magnet: s('<path d="M6 4.5 V12 A6 6 0 0 0 18 12 V4.5"/><path d="M6 4.5 H9.5 V12 A2.5 2.5 0 0 0 14.5 12 V4.5 H18" /><path d="M6 8 H9.5 M14.5 8 H18"/>'),
  trophy: s('<path d="M7.5 4 H16.5 V9 A4.5 4.5 0 0 1 7.5 9 Z"/><path d="M7.5 6 H4.5 V7.5 A3 3 0 0 0 7.8 10.5"/><path d="M16.5 6 H19.5 V7.5 A3 3 0 0 1 16.2 10.5"/><path d="M12 13.5 V17"/><path d="M8.5 20 H15.5 L14.5 17 H9.5 Z"/>'),
  close: s('<path d="M6 6 L18 18 M18 6 L6 18"/>'),
  back: s('<path d="M14.5 6 L8.5 12 L14.5 18"/>'),
  minus: s('<path d="M6 12 H18"/>'),
  plus: s('<path d="M6 12 H18 M12 6 V18"/>'),
  play: s('<path d="M8 5.5 L18.5 12 L8 18.5 Z"/>'),
  bot: s('<rect x="5" y="8" width="14" height="10.5" rx="3.5"/><path d="M12 8 V5"/><circle cx="12" cy="4" r="1"/><path d="M9.5 13 V13.2 M14.5 13 V13.2" stroke-width="2.2"/>'),
};

/** Alto-style rider on a board; the scarf colour comes from the CSS variable --scarf. */
export const RIDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 40">
  <g class="rider__body" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 34.2 Q21 32.4 38 29.8" stroke-width="2.1"/>
    <path d="M14.8 32.6 L18.2 26.4 L16.4 21.8 M26.2 31.2 L24.6 25.4 L20 21.8" stroke-width="2.4"/>
    <path d="M18 22.2 L21.6 15.2" stroke-width="3.6"/>
    <path d="M21 16.6 L26.2 19.4 M20.2 17.2 L16 20.2" stroke-width="1.7"/>
  </g>
  <circle cx="23.2" cy="11.4" r="3.2" fill="currentColor"/>
  <path class="rider__scarf" fill="var(--scarf, #e8553d)" d="M22.4 14.3 C18 13.1 13.6 15 9.4 13.2 C7.4 12.4 5.3 12.9 3.4 14.2 C5.8 10.9 9.6 10.4 13 11.3 C16.4 12.2 19.2 11.6 22.6 12.6 Z"/>
</svg>`;
