/* ORLIX cinematic — WebGL backdrop
   A single fullscreen quad: fbm smoke, ember/violet grading,
   mouse-follow light, scroll-driven drift. No dependencies. */

import { lerp, clamp, isTouch, prefersReducedMotion } from './utils.js';

const VERT = `
attribute vec2 p;
void main(){ gl_Position = vec4(p, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2  u_res;
uniform float u_time;
uniform vec2  u_mouse;   // 0..1, y up
uniform float u_scroll;  // 0..1 page progress
uniform float u_grade;   // 0 ember -> 1 violet
uniform float u_intro;   // 0..1 fade-in

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.,0.)), u.x),
             mix(hash(i + vec2(0.,1.)), hash(i + vec2(1.,1.)), u.x), u.y);
}

float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++){
    v += a * noise(p);
    p = r * p * 2.05 + 11.5;
    a *= 0.5;
  }
  return v;
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 st = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);

  // scroll acts as a slow camera dolly: drift + gentle zoom
  float t = u_time * 0.05;
  vec2 cam = vec2(t * 0.6, -u_scroll * 2.4 + t * 0.25);
  vec2 q = st * (1.35 - 0.25 * u_scroll) + cam;

  // layered smoke
  float n1 = fbm(q * 1.6);
  float n2 = fbm(q * 3.2 + n1 * 1.4 - t);
  float smoke = fbm(q * 2.2 + vec2(n1, n2) * 1.1);
  smoke = smoothstep(0.25, 0.95, smoke);

  // palettes: ember night -> violet depth
  vec3 base  = vec3(0.027, 0.026, 0.028);
  vec3 ember = vec3(0.94, 0.47, 0.19);
  vec3 viol  = vec3(0.55, 0.45, 0.95);
  vec3 tint  = mix(ember, viol, u_grade);

  vec3 col = base + smoke * mix(vec3(0.055, 0.045, 0.042), tint * 0.16, 0.55 + 0.45 * u_grade * 0.3);

  // horizon glow that sinks as you scroll
  float horizon = exp(-abs(st.y + 0.42 - u_scroll * 0.5) * 3.2);
  col += tint * horizon * 0.075;

  // mouse-follow light (dynamic key light)
  vec2 m = u_mouse - uv;
  m.x *= u_res.x / u_res.y;
  float light = exp(-dot(m, m) * 7.0);
  col += tint * light * (0.10 + 0.08 * smoke);

  // faint starfield in the dark regions
  float stars = step(0.9985, hash(floor(gl_FragCoord.xy / 1.5)));
  col += stars * (1.0 - smoke) * 0.35 * vec3(0.9, 0.9, 1.0);

  // subtle scanline shimmer, film feel
  col *= 1.0 - 0.035 * sin(gl_FragCoord.y * 1.7 + u_time * 2.0);

  col *= u_intro;
  gl_FragColor = vec4(col, 1.0);
}
`;

export class GLBackdrop {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', {
      antialias: false,
      alpha: false,
      powerPreference: 'low-power',
    });
    this.ok = !!this.gl;
    if (!this.ok) { canvas.style.display = 'none'; return; }

    this.mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
    this.scroll = 0;
    this.grade = 0;
    this.gradeTarget = 0;
    this.intro = 0;
    this.introTarget = 0;
    this.running = false;
    this.static = prefersReducedMotion();

    this._build();
    this._resize();

    window.addEventListener('resize', () => this._resize(), { passive: true });
    if (!isTouch()) {
      window.addEventListener('pointermove', (e) => {
        this.mouse.tx = e.clientX / innerWidth;
        this.mouse.ty = 1 - e.clientY / innerHeight;
      }, { passive: true });
    }
    document.addEventListener('visibilitychange', () => {
      document.hidden ? this.stop() : this.start();
    });
  }

  _build() {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn('ORLIX gl:', gl.getShaderInfoLog(s));
        this.ok = false;
      }
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!this.ok) { this.canvas.style.display = 'none'; return; }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = {};
    for (const name of ['u_res','u_time','u_mouse','u_scroll','u_grade','u_intro'])
      this.u[name] = gl.getUniformLocation(prog, name);
  }

  _resize() {
    if (!this.ok) return;
    const dpr = clamp(devicePixelRatio || 1, 1, isTouch() ? 1.25 : 1.5);
    const scale = isTouch() ? 0.8 : 1; // render buffer downscale on mobile
    this.canvas.width  = Math.round(innerWidth  * dpr * scale);
    this.canvas.height = Math.round(innerHeight * dpr * scale);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  setScroll(v)  { this.scroll = v; }
  setGrade(v)   { this.gradeTarget = clamp(v, 0, 1); }
  reveal()      { this.introTarget = 1; }

  _frame = (now) => {
    if (!this.running) return;
    const gl = this.gl;
    this.mouse.x = lerp(this.mouse.x, this.mouse.tx, 0.045);
    this.mouse.y = lerp(this.mouse.y, this.mouse.ty, 0.045);
    this.grade   = lerp(this.grade, this.gradeTarget, 0.03);
    this.intro   = lerp(this.intro, this.introTarget, 0.035);

    gl.uniform2f(this.u.u_res, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u.u_time, now * 0.001);
    gl.uniform2f(this.u.u_mouse, this.mouse.x, this.mouse.y);
    gl.uniform1f(this.u.u_scroll, this.scroll);
    gl.uniform1f(this.u.u_grade, this.grade);
    gl.uniform1f(this.u.u_intro, this.intro);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (this.static && this.intro > 0.98) { this.running = false; return; }
    requestAnimationFrame(this._frame);
  };

  start() {
    if (!this.ok || this.running) return;
    this.running = true;
    requestAnimationFrame(this._frame);
  }

  stop() { this.running = false; }
}
