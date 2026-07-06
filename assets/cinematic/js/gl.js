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

mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

/* eclipse rim: a dark disc occluding a light source — the glow spills
   out from behind its edge, focused toward one direction */
float arcGlow(vec2 st, vec2 c, float r, vec2 dir, float focus){
  float d = length(st - c) - r;
  float rim  = exp(-abs(d) * 70.0);
  float halo = exp(-abs(d) * 10.0) * 0.32;
  float outerBias = mix(0.22, 1.0, smoothstep(-0.015, 0.015, d));
  float w = pow(max(dot(normalize(st - c), dir), 0.0), focus);
  return (rim + halo) * outerBias * w;
}

/* crisp hairline with a soft under-glow, fading along its length */
float lineGlow(vec2 st, vec2 p, vec2 n, float len){
  vec2 tp = st - p;
  float dist = abs(dot(tp, n));
  vec2 tang = vec2(n.y, -n.x);
  float along = dot(tp, tang);
  float fade = exp(-along * along / (len * len));
  return (exp(-dist * 260.0) + exp(-dist * 45.0) * 0.22) * fade;
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 st = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  float t = u_time * 0.4;

  // the whole composition turns slowly as the film scrolls
  st = rot(u_scroll * 0.38 - 0.04) * st;

  vec3 base    = vec3(0.012, 0.011, 0.012);
  vec3 ember   = vec3(0.94, 0.47, 0.19);
  vec3 emberHot= vec3(1.0, 0.72, 0.38);
  vec3 viol    = vec3(0.62, 0.50, 0.98);
  vec3 violHot = vec3(0.82, 0.72, 1.0);
  vec3 tint    = mix(ember, viol, u_grade);
  vec3 tintHot = mix(emberHot, violHot, u_grade);

  vec3 col = base;

  float breatheA = 0.86 + 0.14 * sin(t * 0.9);
  float breatheB = 0.86 + 0.14 * sin(t * 0.7 + 2.1);

  // two eclipse edges hugging opposite corners, sliding with scroll
  vec2 c1 = vec2(-0.92, -0.72 + u_scroll * 0.16);
  vec2 c2 = vec2( 0.96,  0.74 - u_scroll * 0.18);
  float g1 = arcGlow(st, c1, 0.58, normalize(vec2( 0.80,  0.60)), 4.5) * breatheA;
  float g2 = arcGlow(st, c2, 0.60, normalize(vec2(-0.75, -0.66)), 4.5) * breatheB;

  // hairline diagonals kissing the arcs, out near the corners
  float l1 = lineGlow(st, vec2(-0.62,  0.44), normalize(vec2(0.55, 0.84)), 0.26) * breatheB;
  float l2 = lineGlow(st, vec2( 0.64, -0.46), normalize(vec2(0.55, 0.84)), 0.26) * breatheA;

  col += tint    * (g1 + g2) * 0.55;
  col += tintHot * (g1 * g1 + g2 * g2) * 0.40;  // white-hot core right at the rim
  col += tint    * (l1 + l2) * 0.34;
  col += tintHot * (l1 * l1 + l2 * l2) * 0.26;

  // faint ambient lift so the black isn't dead flat
  col += tint * 0.008 * max(0.0, 1.0 - length(st));

  // mouse key light, very subtle
  vec2 m = u_mouse - uv;
  m.x *= u_res.x / u_res.y;
  col += tint * exp(-dot(m, m) * 7.0) * 0.05;

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
