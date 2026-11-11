# Snowline

A multiplayer downhill race in the spirit of *Alto's Adventure*, made with p5.js and plain ES modules for the Visual Computing course at UNAL.
Create a room, share the code and race your friends down the same mountain. First to the finish line wins.

Play it at https://danidiaztech.github.io/snowline/

## How to play

| Input | Action |
| --- | --- |
| Tap, click or `Space` | Jump (a tap never flips) |
| Hold for about 0.16 s | Backflip |
| `M` | Mute |
| Gear icon, top right | Settings: graphics quality, sound and volume, reduce effects |

You only use one button, so timing is everything. Your first race starts with a short how-to, and a few hints show up once while you ride.

- Landed tricks make you faster. Each one (backflip, grind, combo) gives a kick and a short boost, and bigger combos boost longer.
- Chain tricks without touching plain snow (flip, grind, flip) to multiply the combo.
- The scarf shows your momentum. It grows with every landed combo and raises your cruising speed. A crash resets it.
- Right after a boost you have a shield for a moment, and rocks and campfires break instead of stopping you.
- Jump the obstacles: rocks, logs, snowmen, ice spikes and campfires.
- Every pit has a ramp just before the edge. Jump from the lip, which is also a good spot for a held backflip. If you fall in, a balloon carries you to the other side and you lose 3 seconds.
- A clean landing keeps your combo. A slightly crooked one slides out and loses the combo, and only a bad one crashes.
- You can grind bunting lines, rooftops and ice. Coins, the feather (hover) and the magnet are worth grabbing.
- A crash costs time but never leaves you stuck.

## Playing with friends

1. One person presses **Create room** and gets a 5-letter code, a share link and a QR code.
2. Everyone else opens the link, scans the QR, or types the code on the home screen. Up to 12 riders.
3. The host picks the course (Sprint / Classic / Marathon), time of day, weather and bots, then presses **Start race**.
4. After the race there is a podium, a full ranking and a few awards (most flips, top speed, biggest combo, cleanest run, comeback). The winner is saved to the **Hall of fame**.
5. The host presses **Rematch** to go again with the same settings, or **Change settings** to go back to the lobby.

While you race, a line under the timer shows how far ahead and behind the nearest riders are, in seconds. Once you finish, the camera follows someone still racing (tap to switch) and a timer shows when the race closes. With **Catch-up** on (a lobby setting, on by default), riders far behind the leader get a small speed bonus until the last tenth of the course.

The host can remove a rider from the lobby. Every rider has their own scarf colour; colours someone else already has are locked.

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

The brokers and the store are free public services with no accounts, so there is no real security and no uptime guarantee. A network that blocks the broker's port can't join that room. School and office Wi-Fi sometimes do this, and mobile data usually works.

If you refresh the page while in a room, the home screen shows a "Rejoin as <name>" button that puts you back in your old slot. If you join while a race is running, you wait in the lobby, watch the live standings and ride the next race. If the host leaves, the next player in the list becomes host and everyone sees a message saying who.

## Running smoothly

Graphics on Auto watches the frame rate and lowers the resolution and effects on slower laptops and phones. On an old machine, pick Low. Muting the sound or switching tabs stops the audio engine. The scene behind the menus runs lighter than a race and stops while a dialog is open. Add `?fps=1` to the URL to see the frame rate and the quality level in a corner.

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

Add `?net=local` to play across several tabs of one browser with no internet. `?tutorial=1` forces the first-run how-to (it is skipped in `?net=local` and `?auto=` test sessions).

Libraries: [p5.js](https://p5js.org) and [MQTT.js](https://github.com/mqttjs/MQTT.js), both in `lib/`.
