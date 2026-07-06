/* ORLIX cinematic — orchestrator */

import { prefersReducedMotion } from './utils.js';
import { GLBackdrop } from './gl.js';
import { Cursor } from './cursor.js';
import { Preloader } from './preloader.js';
import { Menu } from './menu.js';
import { Scenes } from './scenes.js';
import { initTilts } from './tilt.js';
import { initMagnetics, loadMotion } from './magnetic.js';

const hasGsap = typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined';
const hasLenis = typeof Lenis !== 'undefined';
const reduced = prefersReducedMotion();

/* If the animation CDNs failed, degrade to a plain readable page. */
if (!hasGsap) {
  document.getElementById('loader')?.remove();
  document.documentElement.classList.add('no-anim');
}

/* ── smooth scroll ── */
let lenis = null;
if (hasLenis && hasGsap && !reduced) {
  lenis = new Lenis({ lerp: 0.09, smoothWheel: true });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
}

/* ── backdrop, cursor, ui ── */
const gl = new GLBackdrop(document.getElementById('gl'));
gl.start();
new Cursor();
new Menu(lenis);

const scenes = hasGsap ? new Scenes({ gl, lenis }) : null;

/* ── preloader gates the intro (scroll locked until the curtains open) ── */
lenis?.stop();
new Preloader((instant) => {
  lenis?.start();
  gl.reveal();
  scenes?.playHeroIntro(instant);
  if (hasGsap) requestAnimationFrame(() => ScrollTrigger.refresh());
});

if (!hasGsap || reduced) gl.reveal();

/* ── micro-interactions ── */
initTilts();
loadMotion().finally(() => initMagnetics());

/* Keep pinned scenes honest across orientation changes */
if (hasGsap) {
  let rt;
  window.addEventListener('orientationchange', () => {
    clearTimeout(rt);
    rt = setTimeout(() => ScrollTrigger.refresh(), 400);
  });
}
