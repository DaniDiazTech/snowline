/**
 * SNOWLINE — shared contracts.
 *
 * This file is the single source of truth for every shape that crosses a
 * module boundary. It contains constants plus JSDoc typedefs only (no logic).
 * Modules may add private fields to their own objects, but must never rename,
 * remove or change the meaning of anything declared here.
 *
 * World conventions
 *  - Units are world pixels. `PX_PER_M` converts to "metres" for UI only.
 *  - x grows to the right (downhill), y grows DOWN (canvas convention), so the
 *    slope descends towards +x / +y and "up in the air" means smaller y.
 *  - Angles are radians as used by canvas `rotate()`: 0 = level, positive =
 *    clockwise = nose down. A backflip rotates counter-clockwise (angle decreases).
 *  - The simulation runs at a fixed `TICK_HZ`; one `RiderSim.step()` = one tick.
 *    Race time is always `tick * TICK_MS` — never wall-clock time.
 */

export const TICK_HZ = 60;
export const TICK_DT = 1 / TICK_HZ; // seconds
export const TICK_MS = 1000 / TICK_HZ;
export const PX_PER_M = 24;

/** Ms between "GO is scheduled" and "GO" (the 3-2-1 countdown). */
export const COUNTDOWN_MS = 4000;
/** How often the local rider's NetState is broadcast. */
export const NET_SEND_HZ = 12;
export const MAX_PLAYERS = 12;

/** @enum {string} Rider modes. Order matters: index is used on the wire. */
export const RiderMode = Object.freeze({
  IDLE: 'idle', // waiting on the start line
  GROUND: 'ground',
  AIR: 'air',
  GRIND: 'grind',
  CRASHED: 'crashed', // tumbling / recovering, no control
  FINISHED: 'finished', // crossed the line, coasting to a stop
  RESCUE: 'rescue', // fell into a pit: being lifted across to the far lip (x/y follow the lift path), no control
});
export const RIDER_MODES = Object.freeze(Object.values(RiderMode));

/** @enum {string} Feature kinds placed on a course (gameplay-relevant). */
export const FeatureType = Object.freeze({
  ROCK: 'rock',
  CHASM: 'chasm',
  RAMP: 'ramp',
  GRIND: 'grind',
  PICKUP: 'pickup',
  CAMPFIRE: 'campfire',
  LOG: 'log', // fallen tree trunk lying across the slope: low and wide ({x, w, h})
  SNOWMAN: 'snowman', // tall and narrow ({x, w, h})
  SPIKES: 'spikes', // a row of ice shards: very low, long ({x, w, h})
});

/** @enum {string} */
export const GrindKind = Object.freeze({ BUNTING: 'bunting', ROOF: 'roof', ICE: 'ice' });
/** @enum {string} */
export const PickupKind = Object.freeze({ COIN: 'coin', FEATHER: 'feather', MAGNET: 'magnet' });

/** @enum {string} Simulation events (returned by RiderSim.step and re-emitted on the EventBus). */
export const SimEvent = Object.freeze({
  JUMP: 'jump', // {}
  LAND: 'land', // { clean:boolean, impact:number(0..1) }
  TRICK: 'trick', // { name:string, label:string, points:number }  (label is display text, e.g. "Double Backflip")
  COMBO: 'combo', // { points:number, mult:number, total:number, tricks:string[] }  banked on a clean landing
  BOOST: 'boost', // { level:1|2|3, duration:number(s) }
  GRIND_START: 'grindStart', // { featureId, kind }
  GRIND_END: 'grindEnd', // { featureId, length:number(px) }
  ROCK_SMASH: 'rockSmash', // { featureId, x, y }  any solid obstacle smashed while shielded (look up the feature for its type)
  PICKUP: 'pickup', // { featureId, kind, x, y }
  CRASH: 'crash', // { cause:'rock'|'landing'|'chasm'|'campfire'|'log'|'snowman'|'spikes', x, y }
  RESPAWN: 'respawn', // { x, y }
  RESCUE_START: 'rescueStart', // { featureId, duration:number(s), toX, toY }  fell into a pit; the lift begins
  CHASM_CLEAR: 'chasmClear', // { featureId }
  FINISH: 'finish', // { tick:number, timeMs:number }
});

/** @enum {string} App / room phases. */
export const Phase = Object.freeze({
  HOME: 'home',
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  RESULTS: 'results',
});

/** Course length presets, in metres of horizontal distance. */
export const COURSE_LENGTHS = Object.freeze({ sprint: 1400, classic: 2400, marathon: 3800 });
export const WEATHERS = Object.freeze(['auto', 'clear', 'snow', 'storm', 'fog']);
export const START_TIMES = Object.freeze(['auto', 'dawn', 'day', 'golden', 'dusk', 'night']);

/** Rider colours players pick from (scarf + accent). Index is sent on the wire. */
export const PLAYER_COLORS = Object.freeze([
  '#e8553d', '#f2a03d', '#f4d35e', '#7bc950', '#2ec4b6', '#3d9be9',
  '#6c63ff', '#b565d9', '#ef6aa8', '#f7f3e8', '#8d6e63', '#37474f',
]);

/**
 * @typedef {Object} RaceSettings  Chosen by the host in the lobby; part of the start message.
 * @property {'sprint'|'classic'|'marathon'} length
 * @property {'auto'|'clear'|'snow'|'storm'|'fog'} weather   'auto' = derived from the seed
 * @property {'auto'|'dawn'|'day'|'golden'|'dusk'|'night'} startTime  'auto' = derived from the seed
 * @property {number} bots   0..6 AI riders. Every client simulates them locally from the seed (no network traffic); the host's FinishReports for them are authoritative.
 * @property {boolean} catchUp  riders far behind the leader get a small speed bonus (RiderInput.assist). Default true.
 */
export const DEFAULT_SETTINGS = Object.freeze({ length: 'classic', weather: 'auto', startTime: 'auto', bots: 0, catchUp: true });

/* ------------------------------------------------------------------ *
 * WORLD  (src/world/)
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} Feature   Gameplay object on the course. `id` is unique and stable for a seed.
 * @property {number} id
 * @property {string} type     FeatureType
 * @property {number} x        anchor x (for ranged features: same as x0)
 * @property {number} [x0]     ranged features (chasm, grind): start x
 * @property {number} [x1]     ranged features: end x
 * @property {number} [y]      pickups: world y of the centre
 * @property {number} [y0]     grind: y at x0
 * @property {number} [y1]     grind: y at x1
 * @property {number} [sag]    grind: mid-span sag in px (bunting hangs, roofs/ice = 0)
 * @property {string} [kind]   GrindKind | PickupKind
 * @property {number} [size]   rock: radius in px (≈14..30); campfire: radius
 * @property {number} [w]      log / snowman / spikes: full width in px, centred on x
 * @property {number} [h]      log / snowman / spikes: height above the snow in px
 * @property {number} [variant] integer for visual variety (renderer may use it freely)
 */

/**
 * @typedef {Object} Decor     Purely visual object standing on (or near) the slope.
 * @property {'pine'|'deadTree'|'hut'|'windmill'|'pole'|'banner'|'lantern'|'ruin'|'shrub'|'finishArch'|'startGate'} type
 * @property {number} x
 * @property {number} scale    1 = default size
 * @property {number} depth    0 = on the riding line, >0 slightly behind (drawn before the snow lip), <0 in front
 * @property {number} variant
 */

/**
 * @typedef {Object} Zone
 * @property {number} x0
 * @property {number} x1
 * @property {'slopes'|'forest'|'village'|'ridge'} biome
 */

/**
 * @typedef {Object} Course    Immutable, pure function of (seed, settings). Identical on every client.
 * @property {number} seed
 * @property {RaceSettings} settings
 * @property {number} startX          x of the start line
 * @property {number} finishX         x of the finish line
 * @property {number} length          finishX - startX
 * @property {number} minX            terrain is defined on [minX, maxX] (a run-in before the start and a run-out after the finish)
 * @property {number} maxX
 * @property {(x:number)=>number} heightAt   surface y. Inside a chasm it returns the pit floor (far below the lips).
 * @property {(x:number)=>number} slopeAt    dy/dx of the surface (0 inside chasms)
 * @property {Feature[]} features     sorted by x
 * @property {(x0:number,x1:number)=>Feature[]} featuresIn  features overlapping [x0,x1] (cheap; binary search)
 * @property {Decor[]} decor          sorted by x
 * @property {(x0:number,x1:number)=>Decor[]} decorIn
 * @property {Zone[]} zones
 * @property {(feature:Feature, x:number)=>number} grindY   y of a grind line at x (applies sag)
 */

/**
 * World module API (src/world/Course.js):
 *   generateCourse(seed:number, settings:RaceSettings): Course
 */

/* ------------------------------------------------------------------ *
 * SIMULATION  (src/sim/)
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} RiderInput   The whole control scheme is one button.
 * @property {boolean} held       button is down this tick (tap = jump, hold in air = backflip)
 * @property {number} [assist]   0..1 catch-up strength for riders behind the pack (small cruise-speed bonus); missing = 0
 */

/**
 * @typedef {Object} RiderState   Owned and mutated only by RiderSim.
 * @property {number} tick        ticks simulated since GO
 * @property {number} x           board contact point (bottom-centre of the board)
 * @property {number} y
 * @property {number} vx          px/s
 * @property {number} vy
 * @property {number} angle       board angle (see conventions)
 * @property {number} angVel      rad/s
 * @property {string} mode        RiderMode
 * @property {number} speed       |v| in px/s (convenience)
 * @property {number} crouch      0..1 pose hint: 1 = tucked (pre-jump, flipping), 0 = upright
 * @property {number} scarf       0..1 persistent momentum gauge; grows with landed combos, reset by crashes
 * @property {number} boostT      seconds of speed boost left (0 = none)
 * @property {number} boostLevel  0 = none, 1..3 tier of the active boost
 * @property {boolean} shield     true while rocks/campfires are smashed instead of crashing (first part of a boost)
 * @property {number} hoverT      seconds of feather hover left
 * @property {number} magnetT     seconds of coin magnet left
 * @property {number} airTime     seconds in the current air phase
 * @property {number} flips       completed backflips in the current air phase
 * @property {{points:number, mult:number, tricks:string[]}} combo   the combo being built (not yet banked)
 * @property {number} progress    0..1 along the course
 * @property {number} finishTick  tick at which the finish line was crossed, or -1
 * @property {RiderStats} stats
 */

/**
 * @typedef {Object} RiderStats
 * @property {number} score       total banked trick points
 * @property {number} bestCombo
 * @property {number} flips
 * @property {number} grindPx
 * @property {number} crashes
 * @property {number} coins
 * @property {number} topSpeed    px/s, horizontal (the race-relevant speed; drops add vertical speed under strong game gravity)
 */

/**
 * @typedef {Object} SimEventRecord
 * @property {string} type        SimEvent
 * @property {Object} [data]      payload documented next to each SimEvent
 */

/**
 * Sim module API (src/sim/RiderSim.js, src/sim/Bot.js):
 *   class RiderSim {
 *     constructor(course:Course)
 *     state: RiderState                    // read-only for everyone else
 *     consumed: Set<number>                // feature ids this rider has collected / smashed (local only)
 *     step(input:RiderInput): SimEventRecord[]   // advances exactly one tick; deterministic
 *     start(): void                        // IDLE → GROUND at GO
 *   }
 *   class Bot { constructor(course:Course, seed:number, skill:number)   // skill 0..1; decide(state:RiderState): RiderInput }
 *   encodeNetState(state:RiderState): NetState
 *   decodeNetState(net:NetState): RiderView-compatible partial
 */

/**
 * @typedef {Array<number>} NetState  Compact wire form of a rider, sent NET_SEND_HZ times a second:
 *   [tick, x, y, angle*1000, vx, vy, modeIndex, flags, scarf*100]   (all integers)
 *   flags bit0 = boosting, bit1 = shield, bit2 = hover, bits 4-5 = boostLevel
 */

/* ------------------------------------------------------------------ *
 * RENDERING  (src/render/)
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} RiderView   Everything the renderer needs to draw one rider.
 * @property {string} id
 * @property {string} name
 * @property {string} color       hex from PLAYER_COLORS
 * @property {boolean} isLocal
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {number} angle
 * @property {string} mode        RiderMode
 * @property {number} crouch      0..1
 * @property {number} scarf       0..1
 * @property {number} boostLevel  0..3 (0 = not boosting)
 * @property {boolean} shield
 * @property {boolean} hover
 */

/**
 * @typedef {Object} RenderFrame  Passed to Renderer.draw once per animation frame.
 * @property {number} timeMs      race clock driving the day/night cycle and all ambient animation (keeps every client in sync)
 * @property {number} dtMs        real ms since the previous frame (for particles)
 * @property {RiderView} local    the rider the camera follows
 * @property {RiderView[]} others ghosts (remote players and bots)
 * @property {SimEventRecord[]} events  local rider's events since the previous frame (spawn particles, shakes…)
 * @property {string} phase       Phase
 * @property {boolean} [cinematic] true on home/lobby screens: slow drifting camera, no HUD-related overlays
 * @property {Array<{id:string, gapS:number}>} [markers]  off-screen riders worth pointing at (nearest ahead / behind); gapS > 0 = ahead of the local rider
 * @property {string} [focusId]   spectating: id of a rider in `others` the camera follows instead of `local`
 */

/**
 * @typedef {Object} Atmosphere   Output of the day/night + weather model. Pure function of (timeMs, course).
 * @property {number} hour        0..24 in-world time
 * @property {number} night       0 = full day, 1 = deep night
 * @property {string} skyTop      css colour
 * @property {string} skyMid
 * @property {string} skyBottom   horizon colour (also the haze colour distant layers fade to)
 * @property {string} sun         disc colour
 * @property {string} glow        halo colour around sun/moon
 * @property {string[]} ridges    far→near silhouette colours (5 entries)
 * @property {string} snow        lit snow colour of the riding slope
 * @property {string} snowShade   shadow-side / depth colour of the slope body
 * @property {string} silhouette  colour for trees, huts, rocks, riders' bodies
 * @property {string} accent      warm light colour (windows, lanterns, campfires)
 * @property {{x:number,y:number}} sunPos   0..1 screen-space position of the sun (y>1 = below horizon)
 * @property {{x:number,y:number}} moonPos
 * @property {number} stars       0..1 star opacity
 * @property {'clear'|'snow'|'storm'|'fog'} weather
 * @property {number} weatherAmt  0..1 intensity (weather fades in and out)
 * @property {number} flash       0..1 lightning flash this frame
 */

/**
 * Render module API (src/render/Renderer.js, src/render/DayCycle.js):
 *   class Renderer {
 *     constructor(p:p5, course:Course)
 *     setCourse(course:Course): void
 *     resize(width:number, height:number): void
 *     draw(frame:RenderFrame): void
 *     atmosphere: Atmosphere                 // the one used for the last frame (UI/audio read it)
 *     worldToScreen(x:number, y:number): {x:number, y:number}
 *   }
 *   sampleAtmosphere(timeMs:number, course:Course): Atmosphere     // pure
 */

/* ------------------------------------------------------------------ *
 * NETWORK  (src/net/)
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} PlayerInfo
 * @property {string} id          random per-session id
 * @property {string} name        1..14 chars
 * @property {number} colorIndex  index into PLAYER_COLORS
 * @property {boolean} isHost
 * @property {boolean} connected
 * @property {boolean} ready      in the lobby view (false while still watching results)
 */

/**
 * @typedef {Object} StartInfo
 * @property {number} seed
 * @property {RaceSettings} settings
 * @property {number} goAtLocalMs   performance.now()-based local time at which the countdown hits GO
 * @property {number} raceId        increments with each race in the room
 */

/**
 * @typedef {Object} FinishReport   Sent once by each client when its rider finishes (or by the host for DNFs).
 * @property {string} id
 * @property {string} name
 * @property {number} colorIndex
 * @property {number} timeMs        finishTick * TICK_MS, or -1 for DNF
 * @property {number} progress      0..1 (used to order DNFs)
 * @property {RiderStats} stats
 */

/**
 * @typedef {Object} RaceResults
 * @property {number} raceId
 * @property {number} seed
 * @property {RaceSettings} settings
 * @property {FinishReport[]} ranking   sorted: finishers by timeMs asc, then DNFs by progress desc
 */

/**
 * Transport (src/net/Transport.js) — the only file that knows about the wire technology.
 *   interface Transport {
 *     connect(): Promise<void>
 *     publish(topic:string, message:Object, opts?:{ retain?:boolean, reliable?:boolean }): void
 *     subscribe(topicFilter:string, handler:(topic:string, message:Object)=>void): Promise<void>
 *     setLastWill?(topic:string, message:Object): void     // must be called before connect()
 *     close(): void
 *     on(event:'status', cb:(status:'connecting'|'online'|'offline')=>void): void
 *   }
 *
 * Room (src/net/Room.js) — lobby + race protocol on top of a Transport. Emits through a tiny emitter:
 *   class Room {
 *     static create(profile:{name:string,colorIndex:number}): Promise<Room>
 *     static join(code:string, profile:{name:string,colorIndex:number}): Promise<Room>   // rejects with Error('not-found'|'full'|'offline')
 *     code: string                      // 5 chars, unambiguous alphabet, shown to players
 *     selfId: string
 *     isHost: boolean
 *     phase: Phase
 *     players: PlayerInfo[]             // stable join order
 *     settings: RaceSettings
 *     shareUrl: string                  // `${location.origin}${location.pathname}?room=CODE`
 *     setProfile(profile): void
 *     setSettings(partial:Partial<RaceSettings>): void    // host only
 *     startRace(): void                 // host only → everyone gets 'start'
 *     sendState(net:NetState): void     // unreliable, latest-wins
 *     reportFinish(report:FinishReport): void
 *     backToLobby(): void               // host only → phase LOBBY for everyone
 *     leave(): void
 *     on(event, cb): ()=>void           // returns unsubscribe
 *   }
 *   Room events:
 *     'players'  (PlayerInfo[])                 roster changed (join/leave/host change/profile)
 *     'settings' (RaceSettings)
 *     'start'    (StartInfo)
 *     'state'    ({ id:string, net:NetState, recvMs:number })
 *     'finish'   (FinishReport)                 someone crossed the line (live ranking)
 *     'results'  (RaceResults)                  race is over (host decides: all finished, or grace timeout after the winner)
 *     'phase'    (Phase)
 *     'status'   ('connecting'|'online'|'offline')
 *     'closed'   ({ reason:string })
 */

/* ------------------------------------------------------------------ *
 * STORAGE  (src/store/)
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} WinnerRecord
 * @property {string} name
 * @property {number} colorIndex
 * @property {number} timeMs
 * @property {string} length        RaceSettings.length
 * @property {number} players       how many riders raced
 * @property {number} score         winner's trick score
 * @property {string} room          room code
 * @property {number} at            epoch ms
 *
 * WinnersStore (src/store/WinnersStore.js):
 *   add(record:WinnerRecord): Promise<void>        // never throws; falls back to localStorage
 *   list(limit?:number): Promise<WinnerRecord[]>   // newest first; never throws
 */

/* ------------------------------------------------------------------ *
 * AUDIO  (src/audio/)
 * ------------------------------------------------------------------ */

/**
 * AudioEngine (src/audio/AudioEngine.js) — fully procedural WebAudio, no asset files.
 *   class AudioEngine {
 *     unlock(): void                       // call from the first user gesture
 *     setMuted(muted:boolean): void
 *     muted: boolean
 *     startMusic(mood:'menu'|'race'|'results'): void
 *     stopMusic(): void
 *     onSimEvent(event:SimEventRecord): void          // plays the matching sfx
 *     update(view:{ speed:number, mode:string, boostLevel:number, night:number, weather:string, weatherAmt:number, flash:number }): void  // every frame: carve hiss, wind, thunder
 *     ui(name:'click'|'join'|'leave'|'countdown'|'go'|'finish'|'win'): void
 *   }
 */
