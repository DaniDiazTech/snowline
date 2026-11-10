# Snowline — architecture

An Alto's-Adventure-style downhill **race** for up to 12 players in a Kahoot-style room.
Static site (GitHub Pages), **p5.js instance mode + plain ES modules, no build step**, same
conventions as the sibling projects `../2d-arcade` and `../spot-on` (look at them for style:
small classes, JSDoc headers, `src/<area>/<File>.js`, DOM/CSS for all UI, canvas only for the world).

`src/contracts.js` is the binding interface document. Read it first. Never change it;
if something is missing, report it back instead.

## Why there is no latency

Every client simulates **only its own rider**, locally, on a course that is a pure function of
`(seed, settings)`. Input is therefore instant. Other players are drawn as interpolated ghosts
from small state messages (12 Hz). Riders never collide. Race time is counted in simulation
ticks from each client's own GO, so network delay cannot change a result.

## Modules and ownership

| Path | Owns | May import |
| --- | --- | --- |
| `src/contracts.js` | constants + typedefs | — |
| `src/math/` | seeded RNG, noise, splines, helpers | — |
| `src/world/Course.js` | `generateCourse(seed, settings)` | math, contracts |
| `src/sim/` | `RiderSim`, `Bot`, net-state codec, sim tunables | world, math, contracts |
| `src/render/` | `Renderer`, `sampleAtmosphere`, particles, weather | math, contracts (reads Course/RiderView only) |
| `src/audio/AudioEngine.js` | procedural WebAudio | contracts |
| `src/net/` | `Transport`, `Room`, clock sync | contracts |
| `src/store/WinnersStore.js` | hall of fame | contracts |
| `src/ui/` + `index.html` + `style.css` | DOM screens and HUD (pure views with callbacks) | contracts |
| `src/core/Game.js`, `src/main.js` | wiring / state machine | everything |

Rules
- `world`, `sim`, `math` must run in plain Node (no `window`, no p5) so they can be tested headlessly.
- Only `render` touches p5. Only `net/Transport.js` knows the wire technology. Only `ui` touches the DOM
  (besides the canvas). Modules talk through the shapes in `contracts.js`.
- Determinism: world + sim use only the seeded RNG from `src/math`, never `Math.random()` or time.
- No new dependencies without a reason; anything third-party is vendored into `lib/`.
- Tests and scratch scripts live in `../snowline-tests/` (never inside `snowline/`).

## Flow

`home` → create / join room → `lobby` (code, share link, roster, host settings) → host starts →
`countdown` (synchronised GO) → `racing` → `results` (podium + ranking, winner stored) → back to `lobby`.
A solo "practice" run uses the same path without a Room (optionally with bots).
