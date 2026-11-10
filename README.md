# Snowline 🏔️

A multiplayer downhill race in the spirit of *Alto's Adventure*, made with **p5.js** and plain ES modules for *Visual Computing (UNAL)*.
Create a room, share the code, and race your friends down the same mountain. First to the finish line wins.

**▶ Play:** https://danidiaztech.github.io/snowline/

## How to play

| Input | Action |
| --- | --- |
| Tap / click / `Space` | Jump (a tap is a pure jump, never a flip) |
| Hold (about 0.16 s or more) | Backflip |
| `M` | Mute |

It is a one-button game. Everything else is timing.

- **Tricks make you faster.** Every landed trick (backflip, grind, combo) gives an instant kick plus a timed boost. Bigger combos give a bigger, longer boost.
- **Chain tricks** without touching plain snow (flip, grind, flip) to multiply the combo.
- **The scarf is your momentum.** It grows with every landed combo and raises your cruising speed. A crash resets it.
- **While boosting you have a shield** for a moment: rocks and campfires are smashed instead of stopping you.
- **Obstacles:** rocks, logs, snowmen, ice spikes and campfires. Jump them.
- **Pits** always have a ramp: jump from it. If you fall in anyway, a balloon lifts you across to the far side for a 3-second penalty.
- **Landings:** a clean landing keeps your combo. A slightly-off landing slides out and loses the combo instead of crashing; only a bad one crashes.
- Grind the **bunting lines**, **rooftops** and **ice**. Grab coins, the feather (hover) and the magnet.
- Nobody gets stuck: a crash only costs time.

## Playing with friends

1. One person presses **Create room** and gets a 5-letter code, a share link and a QR code.
2. Everyone else opens the link, scans the QR, or types the code on the home screen. Up to 12 riders.
3. The host picks the course (Sprint / Classic / Marathon), time of day, weather and bots, then presses **Start race**.
4. After the race there is a podium and a full ranking. The winner is saved to the **Hall of fame**.

**Practice solo** races three bots without a room.

## How the online part works

There is no game server. The site is static (GitHub Pages).

| Part | How |
| --- | --- |
| No input lag | Every player simulates only their own rider, locally. The course is generated from a seed, so everyone gets the same mountain. |
| Other players | Each client sends its rider's state 12 times a second. The others are drawn as smoothed "ghosts", a moment in the past. Riders don't collide. |
| Fair timing | Race time is counted in simulation ticks (60 per second) from each player's own GO, so network delay can't change a result. |
| Transport | Public MQTT brokers over secure WebSocket. The room code tells a joiner which broker the room is on. |
| Host | The host's browser owns the roster, the settings, the start and the results. If the host leaves, the next player takes over. |
| Hall of fame | A small JSON list on a free key-value store ([textdb.dev](https://textdb.dev)), mirrored in `localStorage`. |

Limits worth knowing: the brokers and the store are free public services with no accounts, so there is no real security and no uptime guarantee. A network that blocks the broker's port can't join that room.

## Day, night and weather

The sky, the mountains, the snow and every silhouette take their colours from one atmosphere model driven by the race clock. A full day lasts about 150 seconds, so a race passes through dawn, day, golden hour, dusk and night. Weather (snow, storm with lightning, fog) fades in and out. Because it all depends only on the seed and the race time, every player sees the same sky.

## Code map

`src/contracts.js` describes every shape that crosses a module boundary. Start there.

| Folder | What it does |
| --- | --- |
| `src/world/` | `generateCourse(seed, settings)`: terrain, chasms, rocks, grind lines, pickups, decor |
| `src/sim/` | `RiderSim` (physics, tricks, combos, boost), `Bot`, the network state codec |
| `src/render/` | Renderer: sky and day cycle, parallax ridges, terrain, riders and scarves, particles, weather, camera |
| `src/net/` | `Transport` (MQTT / loopback), `Room` (lobby and race protocol), clock sync |
| `src/store/` | `WinnersStore` (hall of fame) |
| `src/audio/` | Procedural WebAudio music and sound effects (no audio files) |
| `src/ui/` | DOM screens: home, lobby, HUD, results, hall of fame, QR code |
| `src/core/` | `Game` (state machine), `Race` (one run on this client), `Ghost` (remote rider playback) |
| `dev/` | Harness pages for the renderer, UI, audio and network |

## Course topics used

| Topic | Where |
| --- | --- |
| Perlin noise | Terrain relief and parallax ridges |
| Catmull-Rom splines | Smooth riding surface |
| Animation | Fixed 60 Hz simulation with interpolated rendering; scarf as a chain of segments |
| Colour | Day/night palettes blended per frame |

## Run locally

No build step. Serve the folder with any static server, for example:

```sh
npx http-server . -p 8080 -c-1
```

Add `?net=local` to play across several tabs of one browser with no internet.

Libraries: [p5.js](https://p5js.org) and [MQTT.js](https://github.com/mqttjs/MQTT.js), both in `lib/`.
