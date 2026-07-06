/* ORLIX cinematic — shared utilities */

export const qs  = (s, el = document) => el.querySelector(s);
export const qsa = (s, el = document) => [...el.querySelectorAll(s)];

export const lerp  = (a, b, t) => a + (b - a) * t;
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export const isTouch = () =>
  window.matchMedia('(hover: none), (pointer: coarse)').matches;

export const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Split an element's text into per-word (or per-char) spans.
   Returns the array of created spans. */
export function split(el, mode = 'word') {
  const text = el.textContent;
  const frag = document.createDocumentFragment();
  const out = [];
  const push = (str) => {
    const s = document.createElement('span');
    s.className = 'sp';
    s.style.display = 'inline-block';
    s.style.willChange = 'transform,opacity,filter';
    s.textContent = str;
    frag.appendChild(s);
    out.push(s);
  };
  if (mode === 'char') {
    [...text].forEach((c) => (c === ' ' ? frag.append(' ') : push(c)));
  } else {
    text.split(/\s+/).filter(Boolean).forEach((w, i, arr) => {
      push(w);
      if (i < arr.length - 1) frag.append(' ');
    });
  }
  el.textContent = '';
  el.appendChild(frag);
  return out;
}

/* Decode effect: text resolves out of terminal noise, left to right. */
const GLYPHS = '█▓▒░</>#%&$@*+=~';
export function scramble(el, finalText, { duration = 650 } = {}) {
  if (prefersReducedMotion()) { el.textContent = finalText; return Promise.resolve(); }
  const start = performance.now();
  const len = finalText.length;
  return new Promise((resolve) => {
    const tick = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const solid = Math.floor(p * len);
      let out = finalText.slice(0, solid);
      for (let i = solid; i < len; i++) {
        out += finalText[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      el.textContent = out;
      if (p < 1) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
}

/* Typewriter: types text into el at a steady chars-per-second. */
export function typeText(el, text, { cps = 24, jitter = 0.5 } = {}) {
  if (prefersReducedMotion()) { el.textContent = text; return Promise.resolve(); }
  el.textContent = '';
  return new Promise((resolve) => {
    let i = 0;
    const step = () => {
      el.textContent = text.slice(0, ++i);
      if (i < text.length) {
        setTimeout(step, (1000 / cps) * (1 - jitter / 2 + Math.random() * jitter));
      } else resolve();
    };
    step();
  });
}

/* Split while preserving <br> line breaks: returns spans per word. */
export function splitKeepBreaks(el) {
  const out = [];
  [...el.childNodes].forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      const holder = document.createElement('span');
      holder.textContent = node.textContent;
      node.replaceWith(holder);
      out.push(...split(holder));
      holder.replaceWith(...holder.childNodes);
    }
  });
  return out;
}
