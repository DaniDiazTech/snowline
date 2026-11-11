/**
 * Entry point: creates the p5 sketch (instance mode) that hosts the canvas,
 * builds the renderer, audio, UI and Game, then hands every frame to Game.
 *
 * URL parameters
 *   ?room=CODE   prefill the join code (this is what the share link uses)
 *   ?net=local   play across tabs of one browser with no internet (BroadcastChannel)
 *   ?auto=0.8    a bot drives your rider (automated tests)
 *   ?seed= ?length= ?weather= ?startTime= ?bots=   practice-run overrides
 *   ?fps=1       frame rate + render quality in a corner
 *   ?tutorial=1  force the first-run how-to and hints (=0 hides them)
 */
import { Game } from './core/Game.js';
import { Renderer } from './render/Renderer.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { UI } from './ui/UI.js';
import { generateCourse } from './world/Course.js';
import { DEFAULT_SETTINGS } from './contracts.js';

new window.p5((p) => {
  let game;

  p.setup = () => {
    const canvas = p.createCanvas(window.innerWidth, window.innerHeight);
    canvas.parent('stage');
    p.pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
    dropP5InputListeners(p);

    const params = new URLSearchParams(window.location.search);
    const renderer = new Renderer(p, generateCourse(1, DEFAULT_SETTINGS));
    renderer.resize(window.innerWidth, window.innerHeight);
    game = new Game({ renderer, audio: new AudioEngine(), params });
    game.start(new UI(document.getElementById('ui'), game.handlers));

    // Read-only hook for automated tests and the browser console.
    window.snowline = { snapshot: () => game.debugSnapshot() };
    if (params.has('debug')) window.snowline.game = game;
    document.body.classList.add('is-ready');
    const boot = document.getElementById('boot');
    if (boot) {
      boot.style.opacity = '0';
      boot.style.pointerEvents = 'none';
      setTimeout(() => boot.remove(), 520);
    }
  };

  p.draw = () => {
    game?.frame(p.deltaTime);
  };

  p.windowResized = () => {
    p.resizeCanvas(window.innerWidth, window.innerHeight);
    game?.resize();
  };
});

/**
 * p5 registers non-passive mouse / touch / key listeners on window for its own input API, which the
 * game never uses (src/ui/InputSurface owns input). They cost work on every pointer event (mousemove
 * reads the canvas rect), and non-passive touch listeners make every touch scroll on the menus wait
 * for the main thread. Only 'resize' (→ windowResized) is kept.
 */
function dropP5InputListeners(p) {
  const events = p._events || {};
  for (const [name, fn] of Object.entries(events)) {
    if (name === 'resize' || typeof fn !== 'function') continue;
    window.removeEventListener(name, fn, { passive: false });
    window.removeEventListener(name, fn);
    events[name] = null;
  }
}
