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
