/**
 * scripts/lib/sentinel-vm.js
 *
 * Pure JavaScript implementation of Sentinel SDK VM for solving Turnstile dx challenges.
 * Ported from lxf746/any-auto-register (Python).
 *
 * This enables protocol-mode registration to handle Turnstile challenges without browser fallback.
 */

import crypto from 'node:crypto';
import https from 'node:https';

// ============================================
// CONSTANTS (mirrors upstream platforms/chatgpt/constants.py)
// ============================================
const SENTINEL_BASE = 'https://sentinel.openai.com';
const SENTINEL_SDK_VERSION = '20260124ceb8';
const SENTINEL_FRAME_VERSION = '20260219f9f6';
const SENTINEL_SDK_URL = `${SENTINEL_BASE}/sentinel/${SENTINEL_SDK_VERSION}/sdk.js`;
const SENTINEL_FRAME_URL = `${SENTINEL_BASE}/backend-api/sentinel/frame.html?sv=${SENTINEL_FRAME_VERSION}`;
const SENTINEL_REQ_URL = `${SENTINEL_BASE}/backend-api/sentinel/req`;

// Datadog trace headers (mirrors upstream Python)
export function generateDatadogTraceHeaders() {
  const traceHex = crypto.randomBytes(8).toString('hex').padStart(16, '0');
  const parentHex = crypto.randomBytes(8).toString('hex').padStart(16, '0');
  const traceId = String(BigInt('0x' + traceHex));
  const parentId = String(BigInt('0x' + parentHex));
  return {
    'traceparent': `00-0000000000000000${traceHex}-${parentHex}-01`,
    'tracestate': 'dd=s:1;o:rum',
    'x-datadog-origin': 'rum',
    'x-datadog-parent-id': parentId,
    'x-datadog-sampling-priority': '1',
    'x-datadog-trace-id': traceId,
  };
}

// Register keys (from Python constants)
const R_XOR = 1;
const R_SET = 2;
const R_RESOLVE = 3;
const R_REJECT = 4;
const R_PUSH = 5;
const R_ACCESS = 6;
const R_CALL = 7;
const R_COPY = 8;
const R_QUEUE = 9;
const R_WINDOW = 10;
const R_SCRIPT = 11;
const R_VMSTATE = 12;
const R_CATCH = 13;
const R_JPARSE = 14;
const R_JSTR = 15;
const R_KEY = 16;
const R_TRY = 17;
const R_ATOB = 18;
const R_BTOA = 19;
const R_CONDEQ = 20;
const R_CONDDIST = 21;
const R_EXEC = 22;
const R_CONDEX = 23;
const R_BIND = 24;
const R_NOOP1 = 25;
const R_NOOP2 = 26;
const R_SPLICE = 27;
const R_NOOP3 = 28;
const R_CMPLT = 29;
const R_DEFFN = 30;
const R_MUL = 33;
const R_AWAIT = 34;
const R_DIV = 35;

// ============================================
// UTILITIES
// ============================================
function jsStr(val) {
  if (val === null || val === undefined) return 'undefined';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (Array.isArray(val)) return val.map(jsStr).join(',');
  if (typeof val === 'number') {
    if (Number.isInteger(val) && Math.abs(val) < 2**53) return String(val);
    return String(val);
  }
  return String(val);
}

function xorStr(a, b) {
  if (!b) return a;
  let result = '';
  for (let i = 0; i < a.length; i++) {
    result += String.fromCharCode(a.charCodeAt(i) ^ b.charCodeAt(i % b.length));
  }
  return result;
}

function b64(data) {
  return Buffer.from(JSON.stringify(data, null, 0)).toString('base64');
}

function b64Decode(str) {
  return Buffer.from(String(str || ''), 'base64');
}

// ============================================
// FAKE WINDOW (Browser API Mock)
// ============================================
class FakeWindow {
  constructor(userAgent = '', sdkUrl = '') {
    this.navigator = {
      userAgent,
      language: 'en-US',
      languages: ['en-US', 'en'],
      hardwareConcurrency: 8,
      platform: 'MacIntel',
      maxTouchPoints: 0,
      cookieEnabled: true,
      webdriver: false,
      vendor: 'Google Inc.',
      appVersion: userAgent.replace('Mozilla/', '') || '',
      product: 'Gecko',
      productSub: '20030107',
      deviceMemory: 8,
      connection: { effectiveType: '4g', rtt: 50, downlink: 10 },
      plugins: { length: 5 },
      mimeTypes: { length: 2 },
      pdfViewerEnabled: true,
    };

    const nowBase = Date.now();
    this.performance = {
      timeOrigin: nowBase - 5000,
      now: () => Date.now() - nowBase + 5000,
      memory: {
        jsHeapSizeLimit: 4294705152,
        totalJSHeapSize: 35000000,
        usedJSHeapSize: 25000000,
      },
    };

    this.location = {
      href: 'https://sentinel.openai.com/backend-api/sentinel/frame.html',
      origin: 'https://sentinel.openai.com',
      pathname: '/backend-api/sentinel/frame.html',
      protocol: 'https:',
      host: 'sentinel.openai.com',
      hostname: 'sentinel.openai.com',
      port: '',
    };

    const makeCanvas = () => {
      const ctx2d = {
        fillStyle: '', strokeStyle: '', font: '10px sans-serif',
        fillRect: () => {}, strokeRect: () => {}, clearRect: () => {}, fillText: () => {},
        strokeText: () => {}, measureText: (t) => ({ width: t.length * 6.5 }),
        beginPath: () => {}, closePath: () => {}, arc: () => {}, fill: () => {}, stroke: () => {},
        moveTo: () => {}, lineTo: () => {}, rect: () => {}, clip: () => {}, save: () => {},
        restore: () => {}, translate: () => {}, rotate: () => {}, scale: () => {},
        setTransform: () => {}, createLinearGradient: () => ({ addColorStop: () => {} }),
        createRadialGradient: () => ({ addColorStop: () => {} }), drawImage: () => {},
        getImageData: () => ({ data: new Uint8ClampedArray(0) }), putImageData: () => {},
        createImageData: () => ({ data: new Uint8ClampedArray(0) }),
        canvas: null, globalCompositeOperation: 'source-over', globalAlpha: 1.0,
        lineWidth: 1.0, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10.0,
        shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', shadowOffsetX: 0, shadowOffsetY: 0,
        isPointInPath: () => false,
      };

      const webglExt = {
        UNMASKED_VENDOR_WEBGL: 0x9245,
        UNMASKED_RENDERER_WEBGL: 0x9246,
      };

      const webgl = {
        getParameter: (p) => ({
          0x9245: 'Google Inc. (Intel)',
          0x9246: 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)',
          0x1F01: 'WebKit', 0x1F00: 'WebKit WebGL', 0x8B8C: 256, 0x0D33: 16384,
        }[p] || 0),
        getExtension: (n) => (n?.includes('WEBGL') ? webglExt : {}),
        getSupportedExtensions: () => ['WEBGL_debug_renderer_info', 'EXT_texture_filter_anisotropic'],
        createBuffer: () => ({}), bindBuffer: () => {}, bufferData: () => {},
        createProgram: () => ({}), createShader: () => ({}), shaderSource: () => {},
        compileShader: () => {}, attachShader: () => {}, linkProgram: () => {},
        useProgram: () => {}, getShaderParameter: () => true, getProgramParameter: () => true,
        getAttribLocation: () => 0, getUniformLocation: () => ({}), vertexAttribPointer: () => {},
        enableVertexAttribArray: () => {}, drawArrays: () => {}, viewport: () => {},
        clearColor: () => {}, clear: () => {}, readPixels: () => {},
        canvas: null, VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30,
        ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88E4, COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82,
        FLOAT: 0x1406, TRIANGLES: 0x0004, COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x100,
        RENDERER: 0x1F01, VENDOR: 0x1F00, MAX_TEXTURE_SIZE: 0x0D33,
        MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB,
      };

      const getContext = (ctxType) => {
        if (ctxType === '2d') return ctx2d;
        if (ctxType === 'webgl' || ctxType === 'experimental-webgl' || ctxType === 'webgl2') return webgl;
        return null;
      };

      const canvas = {
        width: 300, height: 150, getContext,
        toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        toBlob: (cb) => { if (typeof cb === 'function') cb(null); },
        style: {},
      };

      ctx2d.canvas = canvas;
      webgl.canvas = canvas;
      return canvas;
    };

    this.document = {
      documentElement: { getAttribute: () => null },
      scripts: sdkUrl ? [{ src: sdkUrl }] : [],
      body: { clientWidth: 1920, clientHeight: 1080 },
      hidden: false, visibilityState: 'visible', hasFocus: () => true,
      createElement: (tag) => (tag === 'canvas' ? makeCanvas() : { style: {}, appendChild: () => {}, removeChild: () => {}, innerHTML: '', textContent: '', getBoundingClientRect: () => ({ x: 0, y: 639.296875, width: 150.9453125, height: 25, top: 639.296875, right: 150.9453125, bottom: 664.296875, left: 0 }) }),
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      fonts: { check: () => true, ready: { then: (fn) => { if (typeof fn === 'function') fn(); } } },
      referrer: '', location: this.location,
    };

    this.screen = {
      width: 1920, height: 1080, availWidth: 1920, availHeight: 1040,
      availLeft: 0, availTop: 0, colorDepth: 24, pixelDepth: 24,
      orientation: { type: 'landscape-primary', angle: 0 },
    };

    this.history = { length: 2 };

    this.localStorage = new Map();
    this.sessionStorage = new Map();

    this.crypto = { getRandomValues: (arr) => crypto.randomFillSync(arr) };

    this.Date = Date;
    this.Math = Math;
    this.JSON = JSON;
    this.Array = Array;
    this.Object = Object;
    this.String = String;
    this.Number = Number;
    this.Boolean = Boolean;
    this.Function = Function;
    this.Error = Error;
    this.TypeError = TypeError;
    this.RangeError = RangeError;
    this.SyntaxError = SyntaxError;
    this.RegExp = RegExp;
    this.Map = Map;
    this.Set = Set;
    this.WeakMap = WeakMap;
    this.WeakSet = WeakSet;
    this.Promise = Promise;
    this.Symbol = Symbol;
    this.parseInt = parseInt;
    this.parseFloat = parseFloat;
    this.isNaN = isNaN;
    this.isFinite = isFinite;
    this.encodeURIComponent = encodeURIComponent;
    this.decodeURIComponent = decodeURIComponent;
    this.btoa = (s) => Buffer.from(s).toString('base64');
    this.atob = (s) => Buffer.from(s, 'base64').toString('binary');
    this.console = console;
    this.setTimeout = setTimeout;
    this.clearTimeout = clearTimeout;
    this.setInterval = setInterval;
    this.clearInterval = clearInterval;
  }
}

// ============================================
// SENTINEL TOKEN GENERATOR
// ============================================
class SentinelTokenGenerator {
  constructor(deviceId, userAgent) {
    this.deviceId = deviceId || crypto.randomUUID();
    this.userAgent = userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
    this.sid = crypto.randomUUID();
  }

  static fnv1a32(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h * 16777619) & 0xFFFFFFFF;
    }
    h ^= (h >> 16);
    h = (h * 2246822507) & 0xFFFFFFFF;
    h ^= (h >> 13);
    h = (h * 3266489909) & 0xFFFFFFFF;
    h ^= (h >> 16);
    return (h & 0xFFFFFFFF).toString(16).padStart(8, '0');
  }

  _config() {
    const perfNow = 1000 + Math.random() * 49000;
    const now = new Date().toUTCString();
    const cores = [4, 8, 12, 16][Math.floor(Math.random() * 4)];
    return [
      '1920x1080', now, 4294705152, Math.random(), this.userAgent, SENTINEL_SDK_URL,
      null, null, 'en-US', 'en-US,en', Math.random(), 'webkitTemporaryStorage−undefined',
      'location', 'Object', perfNow, this.sid, '', cores, Date.now() - perfNow,
    ];
  }

  generateRequirementsToken() {
    const cfg = this._config();
    cfg[3] = 1;
    cfg[9] = Math.round(5 + Math.random() * 45);
    return 'gAAAAAC' + b64(cfg);
  }

  generateToken(seed, difficulty) {
    const maxAttempts = 500000;
    const cfg = this._config();
    const startMs = Date.now();
    const diff = String(difficulty || '0');

    for (let nonce = 0; nonce < maxAttempts; nonce++) {
      cfg[3] = nonce;
      cfg[9] = Math.round(Date.now() - startMs);
      const encoded = b64(cfg);
      const digest = SentinelTokenGenerator.fnv1a32((seed || '') + encoded);
      if (digest.slice(0, diff.length) <= diff) {
        return 'gAAAAAB' + encoded + '~S';
      }
    }
    return 'gAAAAAB' + b64(null);
  }
}

// ============================================
// SENTINEL VM
// ============================================
class SentinelVM {
  constructor(userAgent = '', sdkUrl = '') {
    this.r = {};
    this._win = new FakeWindow(userAgent, sdkUrl);
    this._done = false;
    this._result = null;
    this._iter = 0;
    this._installHandlers();
  }

  _g(k) {
    return this.r[k];
  }

  _s(k, v) {
    this.r[k] = v;
  }

  _installHandlers() {
    const vm = this;

    const h_xor = (dst, keyR) => {
      const a = jsStr(vm._g(dst));
      const b = jsStr(vm._g(keyR));
      vm._s(dst, xorStr(a, b));
    };

    const h_set = (dst, val) => vm._s(dst, val);

    const h_resolve = (val) => {
      if (!vm._done) {
        vm._done = true;
        vm._result = Buffer.from(String(val)).toString('base64');
      }
    };

    const h_reject = (val) => {
      if (!vm._done) {
        vm._done = true;
        vm._result = Buffer.from(String(val)).toString('base64');
      }
    };

    const h_push = (dst, src) => {
      const ex = vm._g(dst);
      const val = vm._g(src);
      if (Array.isArray(ex)) {
        ex.push(val);
      } else {
        vm._s(dst, jsStr(ex || '') + jsStr(val || ''));
      }
    };

    const h_splice = (dst, src) => {
      const ex = vm._g(dst);
      const val = vm._g(src);
      if (Array.isArray(ex)) {
        const idx = ex.indexOf(val);
        if (idx !== -1) ex.splice(idx, 1);
      } else {
        try {
          vm._s(dst, Number(ex || 0) - Number(val || 0));
        } catch (e) { /* ignore */ }
      }
    };

    const h_access = (dst, objR, keyR) => {
      const obj = vm._g(objR);
      const key = vm._g(keyR);
      if (obj === null || obj === undefined) {
        vm._s(dst, null);
        return;
      }
      try {
        if (Array.isArray(obj)) {
          vm._s(dst, obj[Number(key)]);
        } else if (typeof obj === 'string') {
          vm._s(dst, obj[Number(key)]);
        } else if (typeof obj === 'object') {
          vm._s(dst, obj[String(key)]);
        } else {
          vm._s(dst, null);
        }
      } catch (e) {
        vm._s(dst, null);
      }
    };

    const h_call = (fnR, ...argRegs) => {
      const func = vm._g(fnR);
      if (typeof func === 'function') {
        const args = argRegs.map((a) => vm._g(a));
        try { func(...args); } catch (e) { /* ignore */ }
      }
    };

    const h_copy = (dst, src) => vm._s(dst, vm._g(src));

    const h_script = (dst, regexR) => {
      const pattern = String(vm._g(regexR) || '');
      let result = null;
      const scripts = vm._win.document?.scripts || [];
      for (const s of scripts) {
        const src = s.src || '';
        const match = src.match(new RegExp(pattern));
        if (match) {
          result = match.slice(1);
          break;
        }
      }
      vm._s(dst, result);
    };

    const h_vmstate = (dst) => vm._s(dst, vm.r);

    const h_try = (dst, funcR, ...argRegs) => {
      const func = vm._g(funcR);
      const args = argRegs.map((a) => vm._g(a));
      try {
        if (typeof func === 'function') {
          const res = func(...args);
          if (res !== undefined) vm._s(dst, res);
        } else {
          vm._s(dst, null);
        }
      } catch (e) {
        vm._s(dst, String(e));
      }
    };

    const h_catch = (dst, funcR, ...rawArgs) => {
      const func = vm._g(funcR);
      try {
        if (typeof func === 'function') {
          func(...rawArgs);
        } else {
          throw new TypeError(`${typeof func} is not a function`);
        }
      } catch (e) {
        const ename = e.constructor.name;
        vm._s(dst, String(e) ? `${ename}: ${e}` : ename);
      }
    };

    const h_jparse = (dst, srcR) => {
      try {
        vm._s(dst, JSON.parse(String(vm._g(srcR))));
      } catch (e) {
        vm._s(dst, null);
      }
    };

    const h_jstr = (dst, srcR) => {
      try {
        vm._s(dst, JSON.stringify(vm._g(srcR)));
      } catch (e) {
        vm._s(dst, null);
      }
    };

    const h_atob = (r) => {
      try {
        let decoded;
        try {
          decoded = b64Decode(vm._g(r)).toString('latin1');
        } catch (_) {
          decoded = b64Decode(vm._g(r)).toString('binary');
        }
        vm._s(r, decoded);
      } catch (e) { /* ignore */ }
    };

    const h_btoa = (r) => {
      try {
        const s = vm._g(r);
        vm._s(r, Buffer.from(jsStr(s)).toString('base64'));
      } catch (e) { /* ignore */ }
    };

    const h_condeq = (aR, bR, funcR, ...extra) => {
      if (vm._g(aR) === vm._g(bR)) {
        const func = vm._g(funcR);
        if (typeof func === 'function') {
          try { func(...extra); } catch (e) { /* ignore */ }
        }
      }
    };

    const h_conddist = (aR, bR, threshR, funcR, ...extra) => {
      try {
        if (Math.abs(Number(vm._g(aR)) - Number(vm._g(bR))) <= Number(vm._g(threshR))) {
          const func = vm._g(funcR);
          if (typeof func === 'function') {
            func(...extra.map((e) => vm._g(e)));
          }
        }
      } catch (e) { /* ignore */ }
    };

    const h_condex = (valR, funcR, ...extra) => {
      if (vm._g(valR) !== null && vm._g(valR) !== undefined) {
        const func = vm._g(funcR);
        if (typeof func === 'function') {
          try { func(...extra); } catch (e) { /* ignore */ }
        }
      }
    };

    const h_bind = (dst, objR, methodR) => {
      const obj = vm._g(objR);
      const name = vm._g(methodR);
      try {
        vm._s(dst, obj?.[String(name)]);
      } catch (e) {
        vm._s(dst, null);
      }
    };

    const h_cmplt = (dst, aR, bR) => {
      try {
        vm._s(dst, Number(vm._g(aR)) < Number(vm._g(bR)));
      } catch (e) {
        vm._s(dst, false);
      }
    };

    const h_mul = (dst, aR, bR) => {
      try {
        vm._s(dst, Number(vm._g(aR)) * Number(vm._g(bR)));
      } catch (e) {
        vm._s(dst, 0);
      }
    };

    const h_div = (dst, aR, bR) => {
      try {
        const b = Number(vm._g(bR));
        vm._s(dst, b ? Number(vm._g(aR)) / b : 0);
      } catch (e) {
        vm._s(dst, 0);
      }
    };

    const h_await = (dst, srcR) => vm._s(dst, vm._g(srcR));

    const h_exec = (dst, newInsts) => {
      const saved = [...(vm._g(R_QUEUE) || [])];
      const insts = Array.isArray(newInsts) ? [...newInsts] : [];
      vm._s(R_QUEUE, insts);
      try {
        vm._runQueue();
      } catch (e) {
        vm._s(dst, String(e));
      }
      vm._s(R_QUEUE, saved);
    };

    const h_deffn = (nameR, retR, e, r) => {
      const hasParams = Array.isArray(r);
      const paramKeys = hasParams ? e : [];
      const bodyInsts = hasParams ? r : (Array.isArray(e) ? e : []);

      const vmFunc = (...args) => {
        if (vm._done) return;
        const savedQueue = [...(vm._g(R_QUEUE) || [])];
        if (hasParams && Array.isArray(paramKeys)) {
          for (let i2 = 0; i2 < paramKeys.length; i2++) {
            if (i2 < args.length) {
              vm._s(paramKeys[i2], args[i2]);
            }
          }
        }
        vm._s(R_QUEUE, [...bodyInsts]);
        vm._runQueue();
        const result = vm._g(retR);
        vm._s(R_QUEUE, savedQueue);
        return result;
      };

      vm._s(nameR, vmFunc);
    };

    const h_noop = () => {};

    // Install all handlers
    vm._s(R_XOR, h_xor);
    vm._s(R_SET, h_set);
    vm._s(R_RESOLVE, h_resolve);
    vm._s(R_REJECT, h_reject);
    vm._s(R_PUSH, h_push);
    vm._s(R_ACCESS, h_access);
    vm._s(R_CALL, h_call);
    vm._s(R_COPY, h_copy);
    vm._s(R_WINDOW, vm._win);
    vm._s(R_SCRIPT, h_script);
    vm._s(R_VMSTATE, h_vmstate);
    vm._s(R_CATCH, h_catch);
    vm._s(R_JPARSE, h_jparse);
    vm._s(R_JSTR, h_jstr);
    vm._s(R_TRY, h_try);
    vm._s(R_ATOB, h_atob);
    vm._s(R_BTOA, h_btoa);
    vm._s(R_CONDEQ, h_condeq);
    vm._s(R_CONDDIST, h_conddist);
    vm._s(R_EXEC, h_exec);
    vm._s(R_CONDEX, h_condex);
    vm._s(R_BIND, h_bind);
    vm._s(R_NOOP1, h_noop);
    vm._s(R_NOOP2, h_noop);
    vm._s(R_SPLICE, h_splice);
    vm._s(R_NOOP3, h_noop);
    vm._s(R_CMPLT, h_cmplt);
    vm._s(R_DEFFN, h_deffn);
    vm._s(R_MUL, h_mul);
    vm._s(R_AWAIT, h_await);
    vm._s(R_DIV, h_div);
  }

  solve(dxB64, xorKey) {
    if (!dxB64) throw new Error('dx challenge is empty');
    let raw;
    try {
      raw = b64Decode(dxB64).toString('latin1');
    } catch (e) {
      // Fallback: try binary encoding if latin1 fails
      raw = b64Decode(dxB64).toString('binary');
    }
    const decrypted = xorStr(raw, xorKey);
    let instructions;
    try {
      instructions = JSON.parse(decrypted);
    } catch (e) {
      throw new Error(`SentinelVM: failed to parse decrypted instructions: ${e.message}`);
    }

    this._done = false;
    this._result = null;
    this._iter = 0;
    this._maxIterations = 25000;
    this._s(R_KEY, xorKey);
    this._s(R_QUEUE, instructions);

    this._runQueue();

    if (this._result !== null) {
      return this._result;
    }
    return String(this._iter);
  }

  _runQueue() {
    while (!this._done) {
      if (this._iter >= this._maxIterations) {
        throw new Error(`SentinelVM exceeded max iterations (${this._maxIterations})`);
      }
      const queue = this._g(R_QUEUE);
      if (!queue || !Array.isArray(queue) || queue.length === 0) break;

      const inst = queue.shift();
      if (!Array.isArray(inst) || inst.length === 0) continue;

      this._iter++;
      const op = inst[0];
      const handler = this._g(op);
      if (typeof handler === 'function') {
        try {
          handler(...inst.slice(1));
        } catch (e) { /* ignore */ }
      }
    }
  }
}

// ============================================
// MAIN SOLVE FUNCTION
// ============================================
export function solveTurnstileDx(dxB64, pToken, userAgent = '', sdkUrl = '') {
  const vm = new SentinelVM(userAgent, sdkUrl);
  return vm.solve(dxB64, pToken);
}

export function generateSentinelToken(deviceId, userAgent) {
  return new SentinelTokenGenerator(deviceId, userAgent);
}

// Export classes for direct use
export { SentinelVM, SentinelTokenGenerator, FakeWindow };

// ============================================
// CHECK SENTINEL (with full flow)
// ============================================
export async function checkSentinelWithVm(session, deviceId, flow = 'authorize_continue', log = console.log) {
  const userAgent = session.defaultHeaders['User-Agent'] || '';
  const generator = new SentinelTokenGenerator(deviceId, userAgent);

  const sentP = generator.generateRequirementsToken();
  const reqBody = JSON.stringify({ p: sentP, id: deviceId, flow });

  const res = await session.fetch(SENTINEL_REQ_URL, {
    method: 'POST',
    headers: {
      'Origin': 'https://sentinel.openai.com',
      'Referer': SENTINEL_FRAME_URL,
      'Content-Type': 'text/plain;charset=UTF-8',
      'Accept': '*/*',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      ...generateDatadogTraceHeaders(),
    },
    body: reqBody,
    timeoutMs: 10000,
  });

  if (res.status !== 200) {
    log('[Sentinel] Request failed:', res.status);
    return null;
  }

  const data = res.json || {};
  const senToken = String(data.token || '');
  const turnstile = data.turnstile || {};
  const powMeta = data.proofofwork || {};

  let pToken = sentP;

  // Handle PoW challenge if required
  if (powMeta.required && powMeta.seed) {
    log('[Sentinel] PoW required, solving...');
    pToken = generator.generateToken(String(powMeta.seed), String(powMeta.difficulty || '0'));
    log('[Sentinel] PoW solved');
  }

  // Solve Turnstile dx with VM
  let tValue = '';
  const dxB64 = String(turnstile.dx || '');
  if (dxB64) {
    try {
      tValue = solveTurnstileDx(dxB64, sentP, userAgent, SENTINEL_SDK_URL);
      log('[Sentinel] VM solved, t length:', tValue.length);
    } catch (vmErr) {
      log('[Sentinel] VM error:', vmErr.message);
    }
  }

  return {
    token: senToken,
    p: pToken,
    t: tValue,
    demandsProofOfWork: !!powMeta.required,
    demandsTurnstile: !!dxB64,
  };
}
