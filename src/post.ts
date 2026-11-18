import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

/**
 * Catena di post-produzione, tutta in spazio lineare HDR:
 *
 *  scena (MSAA + depth) -> autofocus -> profondita' di campo -> bloom -> uscita
 *
 * Profondita' di campo "da obiettivo", non un filtro: il cerchio di confusione di ogni pixel
 * viene dalla formula della lente sottile (focale, f-stop, distanza di messa a fuoco) e lo
 * sfocato e' un gather a disco a meta' risoluzione che separa campo vicino e lontano
 * (lo schema di Unity PPv2 / Jimenez): niente aloni nitidi attorno ai soggetti, il primo
 * piano sfocato si allarga sopra lo sfondo come in una foto vera.
 *
 * Fascia di nitidezza: attorno al piano di fuoco una profondita' proporzionale alla distanza resta
 * del tutto nitida, cosi' un dolce e' a fuoco dal bordo davanti a quello dietro e lo sfondo resta morbido.
 *
 * Autofocus: un pixel 1x1 tiene la distanza di fuoco. Sulle stazioni vale quella decisa in Blender
 * (centro del soggetto), nei tragitti e' misurata sul depth buffer lungo l'asse ottico e inseguita
 * con un ritardo morbido, come un fuoco a motore.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`

const DEPTH_GLSL = /* glsl */ `
#include <packing>
uniform sampler2D tDepth;
uniform sampler2D tFocus;
uniform float uNear;
uniform float uFar;
uniform float uLensF;     // focale (m)
uniform float uAperture;  // diametro della pupilla (m) = f / N
uniform float uPxPerM;    // pixel (piena risoluzione) per metro di sensore
uniform float uBandNear;  // fascia nitida davanti al fuoco (frazione della distanza)
uniform float uBandFar;   // ... e dietro
uniform float uMaxCoC;    // raggio massimo (pixel piena risoluzione)
float linDepth(vec2 uv) {
  return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar);
}
float focusDist() { return texture2D(tFocus, vec2(0.5)).r; }
/** raggio con segno del cerchio di confusione in pixel: < 0 campo vicino, > 0 campo lontano */
float cocPx(float d, float s) {
  float dn = s * (1.0 - uBandNear);
  float df = s * (1.0 + uBandFar);
  float de = d < dn ? d + s * uBandNear : (d > df ? d - s * uBandFar : s);
  float c = uAperture * uLensF * (de - s) / (de * max(s - uLensF, 1e-4));
  return clamp(0.5 * c * uPxPerM, -uMaxCoC, uMaxCoC);
}`

/** nucleo a dischi concentrici (punti per anello crescenti), normalizzato nel disco unitario */
function diskKernel(rings: number, perRing: number): THREE.Vector2[] {
  const k: THREE.Vector2[] = [new THREE.Vector2(0, 0)]
  for (let r = 1; r <= rings; r++) {
    const n = r * perRing
    const rad = r / rings
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * (i + 0.5 * (r % 2))) / n
      k.push(new THREE.Vector2(Math.cos(a) * rad, Math.sin(a) * rad))
    }
  }
  return k
}

function glslVec2Array(name: string, v: THREE.Vector2[]) {
  return `const vec2 ${name}[${v.length}] = vec2[](${v.map((p) => `vec2(${p.x.toFixed(5)}, ${p.y.toFixed(5)})`).join(', ')});`
}

const mat = (frag: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, string | number> = {}) =>
  new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, defines, depthTest: false, depthWrite: false })

export interface PostFrame {
  /** distanza di fuoco della stazione (m) e quanto pesa rispetto all'autofocus (1 = solo stazione) */
  focusKeyed: number
  stationWeight: number
  lensMm: number
  fstop: number
  /** altezza del sensore equivalente (m) per il fov verticale in uso */
  sensorH: number
  /** punto dell'asse ottico sullo schermo (uv) */
  focusUv: THREE.Vector2
  dofOn: boolean
  dt: number
  time: number
  reset: boolean
}

export function createPost(renderer: THREE.WebGLRenderer, opts: { mobile: boolean; debug?: string | null }) {
  const HF = THREE.HalfFloatType
  const mk = (samples = 0) =>
    new THREE.WebGLRenderTarget(1, 1, { type: HF, samples, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter })

  // scena: MSAA + depth risolto in texture
  const sceneRT = new THREE.WebGLRenderTarget(1, 1, { type: HF, samples: 4, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter })
  sceneRT.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType)
  const compRT = mk()
  const halfA = mk()
  const halfB = mk()
  const focusRT = [0, 1].map(
    () => new THREE.WebGLRenderTarget(1, 1, { type: HF, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }),
  )
  let focusIdx = 0
  const BLOOM_LEVELS = 5
  const down = Array.from({ length: BLOOM_LEVELS }, () => mk())
  const up = Array.from({ length: BLOOM_LEVELS }, () => mk())

  const quad = new FullScreenQuad()
  const lens = {
    tDepth: { value: sceneRT.depthTexture as THREE.Texture },
    tFocus: { value: focusRT[0].texture as THREE.Texture },
    uNear: { value: 0.02 },
    uFar: { value: 60 },
    uLensF: { value: 0.05 },
    uAperture: { value: 0.01 },
    uPxPerM: { value: 1000 },
    uBandNear: { value: 0.045 },
    uBandFar: { value: 0.07 },
    uMaxCoC: { value: 20 },
  }

  // ---------------------------------------------------------------- autofocus (1x1, con memoria)
  const afKernel = diskKernel(2, 6) // 19 punti
  const afMat = mat(
    /* glsl */ `
    ${DEPTH_GLSL}
    uniform sampler2D tPrev;
    uniform vec2 uFocusUv;
    uniform float uAspect, uKeyed, uW, uK, uReset;
    varying vec2 vUv;
    ${glslVec2Array('kAF', afKernel)}
    void main() {
      // media armonica pesata attorno all'asse ottico: privilegia il soggetto piu' vicino
      float accW = 0.0, accInv = 0.0;
      for (int i = 0; i < ${afKernel.length}; i++) {
        vec2 uv = clamp(uFocusUv + kAF[i] * vec2(0.055 / uAspect, 0.055), vec2(0.002), vec2(0.998));
        float d = max(linDepth(uv), 0.05);
        float w = exp(-2.0 * dot(kAF[i], kAF[i]));
        accInv += w / d;
        accW += w;
      }
      float af = accW / accInv;
      float target = mix(af, uKeyed, uW);
      float prev = texture2D(tPrev, vec2(0.5)).r;
      // inseguimento in diottrie (1/m): avvicinamenti e allontanamenti con la stessa morbidezza
      float f = (uReset > 0.5 || prev <= 0.0) ? target : 1.0 / mix(1.0 / prev, 1.0 / target, uK);
      gl_FragColor = vec4(f, 0.0, 0.0, 1.0);
    }`,
    { ...lens, tPrev: { value: null }, uFocusUv: { value: new THREE.Vector2(0.5, 0.5) }, uAspect: { value: 1 }, uKeyed: { value: 1 }, uW: { value: 1 }, uK: { value: 1 }, uReset: { value: 1 } },
  )

  // ---------------------------------------------------------------- DOF: prefiltro a meta' risoluzione
  const prefMat = mat(
    /* glsl */ `
    ${DEPTH_GLSL}
    uniform sampler2D tColor;
    uniform vec2 uTexel; // texel della piena risoluzione
    varying vec2 vUv;
    float m3(vec3 c) { return max(c.r, max(c.g, c.b)); }
    void main() {
      vec2 o = uTexel * 0.5;
      vec2 u0 = vUv + vec2(-o.x, -o.y), u1 = vUv + vec2(o.x, -o.y), u2 = vUv + vec2(-o.x, o.y), u3 = vUv + o;
      vec3 c0 = texture2D(tColor, u0).rgb, c1 = texture2D(tColor, u1).rgb;
      vec3 c2 = texture2D(tColor, u2).rgb, c3 = texture2D(tColor, u3).rgb;
      float s = focusDist();
      // CoC in pixel della meta' risoluzione
      float k0 = 0.5 * cocPx(linDepth(u0), s), k1 = 0.5 * cocPx(linDepth(u1), s);
      float k2 = 0.5 * cocPx(linDepth(u2), s), k3 = 0.5 * cocPx(linDepth(u3), s);
      // pesi per CoC e luminanza: meno travaso del nitido nello sfocato, niente lucciole
      float w0 = abs(k0) / (m3(c0) + 1.0), w1 = abs(k1) / (m3(c1) + 1.0);
      float w2 = abs(k2) / (m3(c2) + 1.0), w3 = abs(k3) / (m3(c3) + 1.0);
      vec3 avg = (c0 * w0 + c1 * w1 + c2 * w2 + c3 * w3) / max(w0 + w1 + w2 + w3, 1e-4);
      float cmin = min(min(k0, k1), min(k2, k3)), cmax = max(max(k0, k1), max(k2, k3));
      float coc = (-cmin > cmax) ? cmin : cmax;
      avg *= smoothstep(0.0, 1.0, abs(coc));
      gl_FragColor = vec4(avg, coc);
    }`,
    { ...lens, tColor: { value: null }, uTexel: { value: new THREE.Vector2() } },
  )

  // ---------------------------------------------------------------- DOF: gather a disco, campo vicino/lontano
  const kernel = diskKernel(opts.mobile ? 3 : 4, 7) // 43 o 71 campioni
  const gatherMat = mat(
    /* glsl */ `
    uniform sampler2D tSrc;
    uniform vec2 uTexel;  // texel della meta' risoluzione
    uniform float uRadius; // raggio del nucleo (pixel meta' risoluzione)
    varying vec2 vUv;
    ${glslVec2Array('kDisk', kernel)}
    void main() {
      vec4 s0 = texture2D(tSrc, vUv);
      vec4 bg = vec4(0.0), fg = vec4(0.0);
      float nearMax = 0.0;
      const float margin = 1.25;
      for (int i = 0; i < ${kernel.length}; i++) {
        vec2 disp = kDisk[i] * uRadius;
        float dist = length(disp);
        vec4 s = texture2D(tSrc, vUv + disp * uTexel);
        // sfondo: il campione conta solo se il suo cerchio (limitato da quello del centro) arriva qui
        float bgCoC = max(min(s0.a, s.a), 0.0);
        float bw = clamp((bgCoC - dist + margin) / margin, 0.0, 1.0);
        // primo piano: il campione sfocato davanti si allarga sopra tutto
        float fw = clamp((-s.a - dist + margin) / margin, 0.0, 1.0) * step(1.0, -s.a);
        bg += vec4(s.rgb, 1.0) * bw;
        fg += vec4(s.rgb, 1.0) * fw;
        nearMax = max(nearMax, fw > 0.0 ? -s.a : 0.0);
      }
      bg.rgb /= bg.a + (bg.a == 0.0 ? 1.0 : 0.0);
      fg.rgb /= fg.a + (fg.a == 0.0 ? 1.0 : 0.0);
      // copertura del campo vicino: campioni raccolti rispetto a quelli attesi dentro il suo cerchio
      float rr = min((nearMax + 0.5 * margin) / max(uRadius, 1e-3), 1.0);
      float expected = max(float(${kernel.length}) * rr * rr, 1.0);
      float fa = clamp(fg.a / expected, 0.0, 1.0);
      gl_FragColor = vec4(mix(bg.rgb, fg.rgb, fa), fa);
    }`,
    { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 8 } },
  )

  // tenda 4 campioni: riempie i vuoti tra gli anelli del nucleo
  const tentMat = mat(
    /* glsl */ `
    uniform sampler2D tSrc;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
      vec2 o = uTexel * 0.5;
      gl_FragColor = 0.25 * (texture2D(tSrc, vUv + vec2(-o.x, -o.y)) + texture2D(tSrc, vUv + vec2(o.x, -o.y)) +
                             texture2D(tSrc, vUv + vec2(-o.x, o.y)) + texture2D(tSrc, vUv + o));
    }`,
    { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
  )

  const compMat = mat(
    /* glsl */ `
    ${DEPTH_GLSL}
    uniform sampler2D tColor;
    uniform sampler2D tDof;
    uniform float uDebug;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tColor, vUv);
      vec4 dof = texture2D(tDof, vUv);
      float coc = cocPx(linDepth(vUv), focusDist());
      float ffa = smoothstep(2.0, 4.0, coc);
      c.rgb = mix(c.rgb, dof.rgb, ffa + dof.a - ffa * dof.a);
      if (uDebug > 0.5) {
        float k = clamp(abs(coc) / uMaxCoC, 0.0, 1.0);
        c.rgb = mix(c.rgb * 0.35, coc < 0.0 ? vec3(0.1, 0.5, 1.0) : vec3(1.0, 0.45, 0.1), k);
      }
      gl_FragColor = c;
    }`,
    { ...lens, tColor: { value: null }, tDof: { value: null }, uDebug: { value: opts.debug === 'coc' ? 1 : 0 } },
  )

  // ---------------------------------------------------------------- bloom (dual filter)
  const threshMat = mat(
    /* glsl */ `
    uniform sampler2D tSrc;
    uniform vec2 uTexel;
    uniform float uThreshold, uKnee;
    varying vec2 vUv;
    vec3 karis(vec3 c) { return c / (1.0 + max(c.r, max(c.g, c.b))); }
    void main() {
      vec2 o = uTexel;
      vec3 a = texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb, b = texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb;
      vec3 c = texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb, d = texture2D(tSrc, vUv + o).rgb;
      vec3 sum = karis(a) + karis(b) + karis(c) + karis(d);
      vec3 col = sum / max(4.0 - max(sum.r, max(sum.g, sum.b)), 0.2);
      float br = max(col.r, max(col.g, col.b));
      float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
      soft = soft * soft / (4.0 * uKnee + 1e-5);
      gl_FragColor = vec4(col * max(soft, br - uThreshold) / max(br, 1e-5), 1.0);
    }`,
    { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0.8 }, uKnee: { value: 0.15 } },
  )
  const downMat = mat(
    /* glsl */ `
    uniform sampler2D tSrc;
    uniform vec2 uHalf; // mezzo pixel della destinazione
    varying vec2 vUv;
    void main() {
      vec4 s = texture2D(tSrc, vUv) * 4.0;
      s += texture2D(tSrc, vUv - uHalf) + texture2D(tSrc, vUv + uHalf);
      s += texture2D(tSrc, vUv + vec2(uHalf.x, -uHalf.y)) + texture2D(tSrc, vUv - vec2(uHalf.x, -uHalf.y));
      gl_FragColor = s / 8.0;
    }`,
    { tSrc: { value: null }, uHalf: { value: new THREE.Vector2() } },
  )
  const upMat = mat(
    /* glsl */ `
    uniform sampler2D tSrc;   // livello piu' piccolo (gia' accumulato)
    uniform sampler2D tBase;  // livello corrente (discesa)
    uniform vec2 uHalf;
    uniform float uSpread;
    varying vec2 vUv;
    void main() {
      vec2 h = uHalf * uSpread;
      vec4 s = texture2D(tSrc, vUv + vec2(-h.x * 2.0, 0.0)) + texture2D(tSrc, vUv + vec2(h.x * 2.0, 0.0));
      s += texture2D(tSrc, vUv + vec2(0.0, h.y * 2.0)) + texture2D(tSrc, vUv + vec2(0.0, -h.y * 2.0));
      s += (texture2D(tSrc, vUv + vec2(-h.x, h.y)) + texture2D(tSrc, vUv + vec2(h.x, h.y)) +
            texture2D(tSrc, vUv + vec2(h.x, -h.y)) + texture2D(tSrc, vUv + vec2(-h.x, -h.y))) * 2.0;
      gl_FragColor = s / 12.0 + texture2D(tBase, vUv);
    }`,
    { tSrc: { value: null }, tBase: { value: null }, uHalf: { value: new THREE.Vector2() }, uSpread: { value: 1 } },
  )

  // ---------------------------------------------------------------- uscita: bloom, aberrazione, grana, sRGB
  const outMat = mat(
    /* glsl */ `
    uniform sampler2D tColor;
    uniform sampler2D tBloom;
    uniform float uBloom, uGrain, uCA, uTime, uFade;
    uniform vec3 uBloomTint;
    uniform vec2 uRes;
    varying vec2 vUv;
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    void main() {
      vec2 d = vUv - 0.5;
      vec2 off = d * dot(d, d) * uCA;
      vec3 c = vec3(texture2D(tColor, vUv - off).r, texture2D(tColor, vUv).g, texture2D(tColor, vUv + off).b);
      c += texture2D(tBloom, vUv).rgb * uBloomTint * (uBloom * 0.2); // 5 livelli sommati
      vec4 o = sRGBTransferOETF(vec4(max(c, 0.0), 1.0));
      // grana di pellicola: rumore triangolare, piu' presente nei mezzitoni
      vec2 px = vUv * uRes;
      float t = floor(uTime * 24.0);
      float g = hash(px + t * 17.17) + hash(px * 1.37 + t * 31.3) - 1.0;
      float l = dot(o.rgb, vec3(0.2126, 0.7152, 0.0722));
      o.rgb += g * uGrain * (0.35 + l * (1.0 - l) * 2.6);
      o.rgb *= uFade;
      gl_FragColor = o;
    }`,
    {
      tColor: { value: null },
      tBloom: { value: null },
      uBloom: { value: 0.22 },
      uBloomTint: { value: new THREE.Color(1.0, 0.93, 0.84) },
      uGrain: { value: opts.mobile ? 0.022 : 0.03 },
      uCA: { value: 0.0045 },
      uTime: { value: 0 },
      uFade: { value: 1 },
      uRes: { value: new THREE.Vector2() },
    },
  )

  let W = 1
  let H = 1
  const run = (m: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) => {
    quad.material = m
    renderer.setRenderTarget(target)
    quad.render(renderer)
  }

  function setSize(w: number, h: number) {
    W = Math.max(1, Math.round(w))
    H = Math.max(1, Math.round(h))
    sceneRT.setSize(W, H)
    compRT.setSize(W, H)
    const hw = Math.ceil(W / 2)
    const hh = Math.ceil(H / 2)
    halfA.setSize(hw, hh)
    halfB.setSize(hw, hh)
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const s = 2 ** (i + 1)
      down[i].setSize(Math.max(1, Math.ceil(W / s)), Math.max(1, Math.ceil(H / s)))
      up[i].setSize(Math.max(1, Math.ceil(W / s)), Math.max(1, Math.ceil(H / s)))
    }
    outMat.uniforms.uRes.value.set(W, H)
  }

  function render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, f: PostFrame) {
    // -- lente
    const fl = f.lensMm / 1000
    lens.uNear.value = camera.near
    lens.uFar.value = camera.far
    lens.uLensF.value = fl
    lens.uAperture.value = fl / Math.max(f.fstop, 1)
    lens.uPxPerM.value = H / f.sensorH
    // raggio massimo: 2.4% dell'altezza, nucleo dimensionato sullo sfocato reale della scena
    const maxR = H * (opts.mobile ? 0.02 : 0.024)
    const s = Math.max(f.focusKeyed, fl * 1.5)
    const inf = (0.5 * ((fl / Math.max(f.fstop, 1)) * fl) / (s - fl)) * (H / f.sensorH)
    lens.uMaxCoC.value = Math.max(2, Math.min(maxR, inf))

    renderer.setRenderTarget(sceneRT)
    renderer.render(scene, camera)

    // -- autofocus
    const prev = focusRT[focusIdx]
    focusIdx ^= 1
    const cur = focusRT[focusIdx]
    const af = afMat.uniforms
    af.tPrev.value = prev.texture
    af.uFocusUv.value.copy(f.focusUv)
    af.uAspect.value = W / H
    af.uKeyed.value = f.focusKeyed
    af.uW.value = f.stationWeight
    af.uK.value = 1 - Math.exp(-f.dt * 4.5)
    af.uReset.value = f.reset ? 1 : 0
    run(afMat, cur)
    lens.tFocus.value = cur.texture

    let color: THREE.Texture = sceneRT.texture
    if (f.dofOn) {
      prefMat.uniforms.tColor.value = sceneRT.texture
      prefMat.uniforms.uTexel.value.set(1 / W, 1 / H)
      run(prefMat, halfA)
      gatherMat.uniforms.tSrc.value = halfA.texture
      gatherMat.uniforms.uTexel.value.set(1 / halfA.width, 1 / halfA.height)
      gatherMat.uniforms.uRadius.value = lens.uMaxCoC.value / 2
      run(gatherMat, halfB)
      tentMat.uniforms.tSrc.value = halfB.texture
      tentMat.uniforms.uTexel.value.set(1 / halfB.width, 1 / halfB.height)
      run(tentMat, halfA)
      compMat.uniforms.tColor.value = sceneRT.texture
      compMat.uniforms.tDof.value = halfA.texture
      run(compMat, compRT)
      color = compRT.texture
    }

    // -- bloom
    threshMat.uniforms.tSrc.value = color
    threshMat.uniforms.uTexel.value.set(1 / W, 1 / H)
    run(threshMat, down[0])
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      downMat.uniforms.tSrc.value = down[i - 1].texture
      downMat.uniforms.uHalf.value.set(0.5 / down[i].width, 0.5 / down[i].height)
      run(downMat, down[i])
    }
    let acc = down[BLOOM_LEVELS - 1]
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
      upMat.uniforms.tSrc.value = acc.texture
      upMat.uniforms.tBase.value = down[i].texture
      upMat.uniforms.uHalf.value.set(0.5 / up[i].width, 0.5 / up[i].height)
      run(upMat, up[i])
      acc = up[i]
    }

    // -- uscita
    const o = outMat.uniforms
    o.tColor.value = color
    o.tBloom.value = acc.texture
    o.uTime.value = f.time
    run(outMat, null)
  }

  return {
    setSize,
    render,
    sceneDepth: sceneRT.depthTexture,
    uniforms: { bloom: outMat.uniforms.uBloom, grain: outMat.uniforms.uGrain, ca: outMat.uniforms.uCA, fade: outMat.uniforms.uFade, threshold: threshMat.uniforms.uThreshold, bandNear: lens.uBandNear, bandFar: lens.uBandFar },
  }
}
