/* ORLIX cinematic — magnetic elements
   [data-magnetic] elements are pulled toward the pointer with a spring.
   Uses Motion (the vanilla sibling of Framer Motion) when it loads,
   falling back to a hand-rolled spring otherwise. */

import { isTouch } from './utils.js';

let motion = null;
export async function loadMotion() {
  try {
    motion = await import('/assets/cinematic/vendor/motion.esm.js');
  } catch { /* fallback spring is used */ }
  return motion;
}

export function initMagnetics(selector = '[data-magnetic]', strength = 0.35) {
  if (isTouch()) return;

  document.querySelectorAll(selector).forEach((el) => {
    let raf = null;
    // fallback spring state
    let x = 0, y = 0, vx = 0, vy = 0, tx = 0, ty = 0;

    const springStep = () => {
      const k = 0.12, d = 0.72;
      vx = (vx + (tx - x) * k) * d;
      vy = (vy + (ty - y) * k) * d;
      x += vx; y += vy;
      el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
      if (Math.abs(vx) + Math.abs(vy) + Math.abs(tx - x) + Math.abs(ty - y) > 0.05) {
        raf = requestAnimationFrame(springStep);
      } else { raf = null; }
    };

    const to = (nx, ny) => {
      if (motion?.animate) {
        motion.animate(el, { x: nx, y: ny },
          { type: 'spring', stiffness: 180, damping: 16, mass: 0.9 });
      } else {
        tx = nx; ty = ny;
        if (!raf) raf = requestAnimationFrame(springStep);
      }
    };

    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      to((e.clientX - (r.left + r.width / 2)) * strength,
         (e.clientY - (r.top + r.height / 2)) * strength);
    }, { passive: true });
    el.addEventListener('pointerleave', () => to(0, 0));
  });
}
