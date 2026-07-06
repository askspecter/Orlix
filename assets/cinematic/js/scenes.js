/* ORLIX cinematic — scene director
   Every ScrollTrigger scene lives here. Each scene is a small,
   self-contained function so scenes can be reordered or removed. */

import { qs, qsa, prefersReducedMotion, scramble, typeText } from './utils.js';

export class Scenes {
  constructor({ gl, lenis }) {
    this.gl = gl;
    this.lenis = lenis;
    this.reduced = prefersReducedMotion();
    if (typeof gsap === 'undefined' || this.reduced) return;

    gsap.registerPlugin(ScrollTrigger);
    this._prepareHero();
    this._manifesto();
    this._reel();
    this._depth();
    this._finale();
    this._credits();
    // created last so their positions account for the reel's pin spacer
    this._globalProgress();
    this._chapterIndicator();
    this._backToTop();
  }

  /* ── initial states so nothing flashes before the intro ── */
  _prepareHero() {
    gsap.set('.ht-char', { yPercent: 120, opacity: 0, filter: 'blur(18px)' });
    gsap.set('.ht-caret', { autoAlpha: 0 });
    gsap.set('[data-intro]', { opacity: 0, y: 26, filter: 'blur(8px)' });
  }

  /* Called by app.js the moment the loader curtains start opening. */
  playHeroIntro(instant = false) {
    const cmd = qs('#heroCmd');
    if (typeof gsap === 'undefined' || this.reduced || instant) {
      gsap?.set('.ht-char, .ht-caret, [data-intro]', { yPercent: 0, y: 0, autoAlpha: 1, filter: 'blur(0px)' });
      if (cmd) cmd.textContent = cmd.dataset.type;
      return;
    }
    const tl = gsap.timeline({ defaults: { ease: 'power4.out' } });
    tl.to('.ht-char', {
      yPercent: 0, opacity: 1, filter: 'blur(0px)',
      duration: 1.5, stagger: { each: 0.075, from: 'center' },
    }, 0.1);
    tl.to('.ht-caret', { autoAlpha: 1, duration: 0.1 }, 1.0);
    tl.to('[data-intro]', {
      opacity: 1, y: 0, filter: 'blur(0px)', duration: 1.1, stagger: 0.12,
    }, 0.75);
    tl.add(() => { if (cmd) typeText(cmd, cmd.dataset.type); }, 1.0);

    // Hero exits like a camera tilt: title drifts up, blurs out of focus
    gsap.to('.hero-title', {
      yPercent: -32, opacity: 0.06, filter: 'blur(14px)', ease: 'none',
      scrollTrigger: { trigger: '#hero', start: 'top top', end: 'bottom top', scrub: true },
    });
    gsap.to('.hero-sub, .hero-meta, .hero-kicker', {
      yPercent: -140, opacity: 0, ease: 'none',
      scrollTrigger: { trigger: '#hero', start: 'top top', end: '55% top', scrub: true },
    });
  }

  /* ── shader scroll uniform ── */
  _globalProgress() {
    ScrollTrigger.create({
      trigger: document.body, start: 'top top', end: 'max',
      onUpdate: (self) => this.gl?.setScroll(self.progress),
    });
  }

  /* ── chapter tag in the header follows the active scene ── */
  _chapterIndicator() {
    const num = qs('#chapterNum'), name = qs('#chapterName');
    qsa('[data-chapter]').forEach((scene) => {
      ScrollTrigger.create({
        trigger: scene, start: 'top 45%', end: 'bottom 45%',
        onToggle: (self) => {
          if (!self.isActive) return;
          num.textContent = scene.dataset.chapter;
          scramble(name, scene.dataset.chapterName, { duration: 450 });
        },
      });
    });
    // shader color grade per act
    const grades = [['#hero', 0], ['#manifesto', 0.22], ['#depth', 1], ['#finale', 0.12]];
    grades.forEach(([sel, g]) => {
      ScrollTrigger.create({
        trigger: sel, start: 'top 55%', end: 'bottom 55%',
        onToggle: (self) => { if (self.isActive) this.gl?.setGrade(g); },
      });
    });
  }

  /* ── CH01: pinned manifesto, blur-to-focus line by line ── */
  _manifesto() {
    const lines = qsa('[data-mani]');
    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: '#manifesto', start: 'top top', end: 'bottom bottom', scrub: 0.6,
      },
    });
    lines.forEach((line, i) => {
      tl.fromTo(line,
        { opacity: 0, filter: 'blur(24px)', scale: 0.92, yPercent: 8 },
        { opacity: 1, filter: 'blur(0px)', scale: 1, yPercent: 0, duration: 1, ease: 'power2.out' });
      tl.to({}, { duration: 0.6 }); // hold in focus
      if (i < lines.length - 1) {
        tl.to(line, { opacity: 0, filter: 'blur(26px)', scale: 1.07, yPercent: -8, duration: 1, ease: 'power2.in' });
      } else {
        tl.to(line, { opacity: 0, filter: 'blur(14px)', scale: 1.04, duration: 0.7, ease: 'power2.in' }, '+=0.2');
      }
    });
  }

  /* ── CH02: horizontal reel with scroll-driven camera ── */
  _reel() {
    const track = qs('#reelTrack');
    const dist = () => track.scrollWidth - window.innerWidth;

    const scrub = gsap.to(track, {
      x: () => -dist(),
      ease: 'none',
      scrollTrigger: {
        trigger: '#reel', pin: '.reel-pin', start: 'top top',
        end: () => `+=${dist()}`,
        scrub: 0.8, invalidateOnRefresh: true, anticipatePin: 1,
        // grade drifts ember → violet across the reel
        onUpdate: (self) => this.gl?.setGrade(0.15 + self.progress * 0.75),
      },
    });

    // Per-panel choreography rides the container animation
    qsa('.panel').forEach((panel) => {
      const titleParts = panel.querySelectorAll('[data-pt]');
      // titles decode out of terminal noise the first time they enter frame
      ScrollTrigger.create({
        trigger: panel, containerAnimation: scrub,
        start: 'left 75%', once: true,
        onEnter: () => titleParts.forEach((s, i) =>
          setTimeout(() => scramble(s, s.textContent, { duration: 600 }), i * 140)),
      });
      gsap.fromTo(titleParts,
        { xPercent: (i) => (i ? 45 : -45), opacity: 0 },
        {
          xPercent: 0, opacity: 1, ease: 'power2.out',
          scrollTrigger: {
            trigger: panel, containerAnimation: scrub,
            start: 'left 80%', end: 'center center', scrub: true,
          },
        });
      gsap.fromTo(panel.querySelector('.panel-card'),
        { y: 90, rotateY: -8, opacity: 0 },
        {
          y: 0, rotateY: 0, opacity: 1, ease: 'power2.out',
          scrollTrigger: {
            trigger: panel, containerAnimation: scrub,
            start: 'left 70%', end: 'center 60%', scrub: true,
          },
        });
      // depth: number drifts slower than the card (layered parallax)
      gsap.fromTo(panel.querySelector('.panel-num'),
        { xPercent: 140 },
        {
          xPercent: -40, ease: 'none',
          scrollTrigger: {
            trigger: panel, containerAnimation: scrub,
            start: 'left right', end: 'right left', scrub: true,
          },
        });
    });
  }

  /* ── CH03: camera descends through data layers ── */
  _depth() {
    const layers = qsa('.depth-layer');
    const rings = qs('.depth-rings');

    gsap.set(layers, { z: -650, autoAlpha: 0, filter: 'blur(20px)' });

    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: '#depth', start: 'top top', end: 'bottom bottom', scrub: 0.5,
      },
    });

    layers.forEach((layer) => {
      const counter = layer.querySelector('.count');
      const target = counter ? +counter.dataset.count : 0;
      const state = { v: 0 };
      tl.fromTo(layer,
        { z: -480, autoAlpha: 0, filter: 'blur(16px)' },
        { z: 0, autoAlpha: 1, filter: 'blur(0px)', duration: 0.7, ease: 'power1.out' });
      if (counter) {
        tl.to(state, {
          v: target, duration: 0.55, ease: 'power1.out',
          onUpdate: () => { counter.textContent = Math.round(state.v); },
        }, '<0.2');
      }
      tl.to({}, { duration: 1.4 }); // long hold in focus
      tl.to(layer, { z: 420, autoAlpha: 0, filter: 'blur(14px)', duration: 0.5, ease: 'power1.in' });
    });

    gsap.to(rings, {
      rotate: 70, scale: 1.7, ease: 'none',
      scrollTrigger: { trigger: '#depth', start: 'top top', end: 'bottom bottom', scrub: true },
    });
  }

  /* ── CH04: finale rises from the cut ── */
  _finale() {
    gsap.set('[data-fin]', { yPercent: 110 });
    gsap.fromTo('[data-fin]',
      { yPercent: 110 },
      {
        yPercent: 0, ease: 'power4.out', duration: 1.3, stagger: 0.12,
        scrollTrigger: { trigger: '#finale', start: 'top 62%' },
      });
    gsap.fromTo('.fin-kicker, .fin-actions',
      { opacity: 0, y: 30 },
      {
        opacity: 1, y: 0, duration: 1, ease: 'power3.out', stagger: 0.15,
        scrollTrigger: { trigger: '#finale', start: 'top 55%' },
      });
    // slow push-in while the finale is on screen
    gsap.fromTo('.fin-title',
      { scale: 0.92 },
      {
        scale: 1.04, ease: 'none',
        scrollTrigger: { trigger: '#finale', start: 'top bottom', end: 'bottom top', scrub: true },
      });
  }

  /* ── credits roll in like end titles ── */
  _credits() {
    gsap.fromTo('.cr-row',
      { opacity: 0, y: 34 },
      {
        opacity: 1, y: 0, duration: 0.9, ease: 'power3.out', stagger: 0.08,
        scrollTrigger: { trigger: '.credits', start: 'top 78%' },
      });
  }

  _backToTop() {
    qs('#toTop')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.lenis ? this.lenis.scrollTo(0, { duration: 2.2 }) : window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
}
