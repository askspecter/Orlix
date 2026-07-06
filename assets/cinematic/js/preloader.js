/* ORLIX cinematic — preloader
   Counts up while fonts/assets settle, title letters rise, then the
   curtains split open like a shutter to reveal the film. */

import { prefersReducedMotion } from './utils.js';

export class Preloader {
  constructor(onComplete) {
    this.el = document.getElementById('loader');
    this.onComplete = onComplete;
    if (!this.el || prefersReducedMotion() || typeof gsap === 'undefined') {
      this.el?.remove();
      onComplete?.(true /* instant */);
      return;
    }
    this._run();
  }

  _run() {
    const count = document.getElementById('loaderCount');
    const bar   = document.getElementById('loaderBar');
    const chars = this.el.querySelectorAll('.loader-word .lw');
    const state = { v: 0 };
    let assetsReady = false;

    const ready = Promise.all([
      new Promise((res) => (document.readyState === 'complete'
        ? res() : window.addEventListener('load', res, { once: true }))),
      document.fonts?.ready ?? Promise.resolve(),
    ]).then(() => { assetsReady = true; });

    // Hard ceiling so a stalled asset can't trap the user
    const failsafe = new Promise((res) => setTimeout(res, 6000));

    const tl = gsap.timeline();
    tl.to(chars, {
      y: 0, opacity: 1, duration: 1.1, ease: 'power4.out', stagger: 0.07,
      startAt: { y: '110%' },
    }, 0.15);
    tl.to(state, {
      v: 99, duration: 2.1, ease: 'power2.inOut',
      onUpdate: () => {
        count.textContent = String(Math.round(state.v)).padStart(3, '0');
        bar.style.transform = `scaleX(${state.v / 100})`;
      },
    }, 0.15);

    tl.eventCallback('onComplete', async () => {
      await Promise.race([ready, failsafe]);
      this._out(count, bar, chars);
    });
  }

  _out(count, bar, chars) {
    const tl = gsap.timeline({
      onComplete: () => { this.el.remove(); },
    });
    tl.to({}, {
      duration: 0.3,
      onStart: () => { count.textContent = '100'; bar.style.transform = 'scaleX(1)'; },
    });
    tl.to(chars, { y: '-110%', opacity: 0, duration: 0.7, ease: 'power3.in', stagger: 0.04 }, 0.15);
    tl.to('.loader-kicker, .loader-meta', { opacity: 0, duration: 0.4 }, 0.2);
    tl.add(() => this.onComplete?.(false), 0.75); // start hero intro under the opening curtains
    tl.to('.lc-top',    { yPercent: -100, duration: 1.05, ease: 'power4.inOut' }, 0.8);
    tl.to('.lc-bottom', { yPercent:  100, duration: 1.05, ease: 'power4.inOut' }, 0.8);
  }
}
