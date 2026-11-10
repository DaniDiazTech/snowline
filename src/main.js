/**
 * Entry point: creates the p5 sketch (instance mode) that hosts the canvas,
 * builds the renderer, audio, UI and Game, then hands every frame to Game.
 *
 * URL parameters
 *   ?room=CODE   prefill the join code (this is what the share link uses)
 *   ?net=local   play across tabs of one browser with no internet (BroadcastChannel)
 *   ?auto=0.8    a bot drives your rider (automated tests)
 *   ?seed= ?length= ?weather= ?startTime= ?bots=   practice-run overrides
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

    const params = new URLSearchParams(window.location.search);
    const renderer = new Renderer(p, generateCourse(1, DEFAULT_SETTINGS));
    renderer.resize(window.innerWidth, window.innerHeight);
    game = new Game({ renderer, audio: new AudioEngine(), params });
    game.start(new UI(document.getElementById('ui'), game.handlers));

    // Read-only hook for automated tests and the browser console.
    window.snowline = { snapshot: () => game.debugSnapshot() };
    if (params.has('debug')) window.snowline.game = game;
    document.body.classList.add('is-ready');
  };

  p.draw = () => {
    game?.frame(p.deltaTime);
  };

  p.windowResized = () => {
    p.resizeCanvas(window.innerWidth, window.innerHeight);
    game?.resize();
  };
});
