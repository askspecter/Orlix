/* ORLIX cinematic — 3D tilt cards
   [data-tilt] elements rotate toward the pointer with inertia;
   a .pc-glare child gets --gx/--gy for the specular highlight. */

import { lerp, clamp, isTouch } from './utils.js';

export class Tilt {
  constructor(el, { max = 10, perspective = 900 } = {}) {
    this.el = el;
    this.max = max;
    this.glare = el.querySelector('.pc-glare');
    this.rx = 0; this.ry = 0;
    this.trx = 0; this.try = 0;
    this.active = false;
    el.style.transform = `perspective(${perspective}px)`;
    this.perspective = perspective;

    if (isTouch()) return;

    el.addEventListener('pointerenter', () => { this.active = true; this._raf(); });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const px = clamp((e.clientX - r.left) / r.width, 0, 1);
      const py = clamp((e.clientY - r.top) / r.height, 0, 1);
      this.try = (px - 0.5) * 2 * this.max;      // rotateY
      this.trx = (0.5 - py) * 2 * this.max;      // rotateX
      if (this.glare) {
        this.glare.style.setProperty('--gx', `${px * 100}%`);
        this.glare.style.setProperty('--gy', `${py * 100}%`);
      }
    }, { passive: true });
    el.addEventListener('pointerleave', () => {
      this.trx = 0; this.try = 0;
    });
  }

  _raf = () => {
    this.rx = lerp(this.rx, this.trx, 0.09);
    this.ry = lerp(this.ry, this.try, 0.09);
    this.el.style.transform =
      `perspective(${this.perspective}px) rotateX(${this.rx.toFixed(3)}deg) rotateY(${this.ry.toFixed(3)}deg)`;
    const settled = !this.active && Math.abs(this.rx) < 0.01 && Math.abs(this.ry) < 0.01;
    if (settled) { this.el.style.transform = `perspective(${this.perspective}px)`; return; }
    requestAnimationFrame(this._raf);
  };
}

/* pointerleave should stop the loop once settled */
export function initTilts(selector = '[data-tilt]') {
  return [...document.querySelectorAll(selector)].map((el) => {
    const t = new Tilt(el);
    el.addEventListener('pointerleave', () => { t.active = false; });
    return t;
  });
}
