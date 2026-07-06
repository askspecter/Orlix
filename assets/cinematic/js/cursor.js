/* ORLIX cinematic — custom cursor
   Ring + dot follow the pointer on separate easings; elements with
   [data-hover] grow the ring, [data-cursor="WORD"] fills it with a label. */

import { lerp, isTouch } from './utils.js';

export class Cursor {
  constructor() {
    this.enabled = !isTouch();
    if (!this.enabled) return;

    this.ring  = document.getElementById('cursor');
    this.dot   = document.getElementById('cursorDot');
    this.label = document.getElementById('cursorLabel');
    if (!this.ring || !this.dot) { this.enabled = false; return; }

    document.body.classList.add('has-cursor');
    this.x = innerWidth / 2;  this.y = innerHeight / 2;
    this.rx = this.x;         this.ry = this.y;
    this.dx = this.x;         this.dy = this.y;

    window.addEventListener('pointermove', (e) => {
      this.x = e.clientX; this.y = e.clientY;
    }, { passive: true });
    window.addEventListener('pointerdown', () => this.ring.classList.add('is-down'));
    window.addEventListener('pointerup',   () => this.ring.classList.remove('is-down'));

    // Event delegation so dynamically-animated nodes work too
    document.addEventListener('pointerover', (e) => {
      const t = e.target.closest('[data-hover]');
      if (!t) return;
      this.ring.classList.add('is-hover');
      const word = t.getAttribute('data-cursor');
      if (word) {
        this.label.textContent = word;
        this.ring.classList.add('has-label');
      }
    });
    document.addEventListener('pointerout', (e) => {
      if (e.target.closest('[data-hover]')) {
        this.ring.classList.remove('is-hover', 'has-label');
      }
    });

    this._raf();
  }

  _raf = () => {
    if (!this.enabled) return;
    this.rx = lerp(this.rx, this.x, 0.14);
    this.ry = lerp(this.ry, this.y, 0.14);
    this.dx = lerp(this.dx, this.x, 0.5);
    this.dy = lerp(this.dy, this.y, 0.5);
    this.ring.style.transform = `translate3d(${this.rx}px, ${this.ry}px, 0)`;
    this.dot.style.transform  = `translate3d(${this.dx}px, ${this.dy}px, 0)`;
    requestAnimationFrame(this._raf);
  };
}
