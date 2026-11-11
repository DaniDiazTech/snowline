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
  clock: s('<circle cx="12" cy="13" r="7.5"/><path d="M12 9 V13 L14.8 14.8"/><path d="M10 3.5 H14 M12 3.5 V5.5"/>'),
  podium: s('<path d="M3.5 20.5 V14 H8.5 V20.5 M8.5 20.5 V9.5 H15.5 V20.5 M15.5 20.5 V12 H20.5 V20.5 Z M3 20.5 H21"/>'),
  finish: s('<path d="M5.5 21 V3.5"/><path d="M5.5 4 H18.5 V12.5 H5.5"/><path d="M5.5 4 H9.8 V8.2 H5.5 Z M14.1 4 H18.5 V8.2 H14.1 Z M9.8 8.2 H14.1 V12.5 H9.8 Z" fill="currentColor" stroke="none"/>'),
  wind: s('<path d="M3.5 9 H14.5 A3 3 0 1 0 11.5 6"/><path d="M3.5 13 H18 A3 3 0 1 1 15 16"/><path d="M3.5 17 H9"/>'),
  eye: s('<path d="M2.5 12 C5 7.5 8.5 5.5 12 5.5 C15.5 5.5 19 7.5 21.5 12 C19 16.5 15.5 18.5 12 18.5 C8.5 18.5 5 16.5 2.5 12 Z"/><circle cx="12" cy="12" r="3"/>'),
  remove: s('<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12 H15.5"/>'),
  gear: s('<circle cx="12" cy="12" r="3"/><path d="M12 2.8 V5.2 M12 18.8 V21.2 M2.8 12 H5.2 M18.8 12 H21.2 M5.5 5.5 L7.2 7.2 M16.8 16.8 L18.5 18.5 M5.5 18.5 L7.2 16.8 M16.8 7.2 L18.5 5.5"/><circle cx="12" cy="12" r="6.6"/>'),
  expand: s('<path d="M4 9 V4 H9 M15 4 H20 V9 M20 15 V20 H15 M9 20 H4 V15"/>'),
  shrink: s('<path d="M9 4 V9 H4 M20 9 H15 V4 M15 20 V15 H20 M4 15 H9 V20"/>'),
  rotate: s('<rect x="7.5" y="3" width="9" height="16" rx="2"/><path d="M3.5 13.5 A8.5 8.5 0 0 0 10 21" /><path d="M7.6 20.6 L10 21 L9.4 18.6"/>'),
  tap: s('<circle cx="12" cy="9" r="3.2"/><path d="M12 3 V3.4 M6.4 5.6 L6.7 5.9 M17.6 5.6 L17.3 5.9"/><path d="M12 12.5 V20.5"/><path d="M8.5 17 L12 20.5 L15.5 17"/>'),
  hold: s('<path d="M7 14.5 A5.5 5.5 0 1 0 12 6.5"/><path d="M12 3.8 L12 9.2 L9.6 6.5 Z" fill="currentColor"/>'),
  bolt: s('<path d="M13.5 3 L5.5 13.5 H11.5 L10.5 21 L18.5 10.5 H12.5 Z"/>'),
  balloon: s('<path d="M12 3.5 C8.4 3.5 6 6.2 6 9.4 C6 13 9.2 15.6 12 16 C14.8 15.6 18 13 18 9.4 C18 6.2 15.6 3.5 12 3.5 Z"/><path d="M12 16 L11 18 H13 Z"/><path d="M12 18 C12 19.5 13 20 12.5 21"/>'),
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
