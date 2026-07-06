/* ORLIX cinematic — fullscreen menu
   Circle clip-path reveal (CSS) + staggered link entrances (GSAP).
   Locks Lenis while open. */

export class Menu {
  constructor(lenis) {
    this.lenis = lenis;
    this.el = document.getElementById('menu');
    this.btn = document.getElementById('menuBtn');
    this.links = this.el ? [...this.el.querySelectorAll('.menu-list a')] : [];
    this.foot = this.el?.querySelector('.menu-foot');
    this.open = false;
    if (!this.el || !this.btn) return;

    this.btn.addEventListener('click', () => this.toggle());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) this.toggle();
    });
    // Close before navigating so the reveal never strands the user
    this.links.forEach((a) => a.addEventListener('click', () => {
      if (this.open) this.toggle();
    }));
  }

  toggle() {
    this.open = !this.open;
    this.el.classList.toggle('is-open', this.open);
    this.el.setAttribute('aria-hidden', String(!this.open));
    this.btn.setAttribute('aria-expanded', String(this.open));
    this.btn.querySelector('.hm-txt').textContent = this.open ? 'CLOSE' : 'MENU';

    if (typeof gsap === 'undefined') return;
    if (this.open) {
      this.lenis?.stop();
      gsap.fromTo(this.links,
        { opacity: 0, y: 46 },
        { opacity: 1, y: 0, duration: 0.9, ease: 'power4.out', stagger: 0.055, delay: 0.28, overwrite: true });
      gsap.fromTo(this.foot,
        { opacity: 0, y: 20 },
        { opacity: 1, y: 0, duration: 0.7, ease: 'power3.out', delay: 0.6, overwrite: true });
    } else {
      this.lenis?.start();
      gsap.to([...this.links, this.foot],
        { opacity: 0, y: -14, duration: 0.3, ease: 'power2.in', overwrite: true });
    }
  }
}
