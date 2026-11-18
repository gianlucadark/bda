import * as THREE from 'three'
import type { Manifest } from './scene'

/**
 * Aria della sala, sopra la scena cotta:
 *  - coni di luce dei faretti, appena percepibili, con un pulviscolo che li attraversa lento
 *  - il vapore dell'espresso appena servito
 * Tutto additivo o trasparente, senza scrittura nel depth buffer: la profondita' di campo
 * continua a leggere solo la geometria vera.
 */

const NOISE = /* glsl */ `
float h31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }`

interface Beam {
  pos: THREE.Vector3
  dir: THREE.Vector3
  cosOuter: number
  cosInner: number
  length: number
  gain: number
  color: THREE.Color
}

export function createAtmosphere(
  manifest: Manifest,
  hitDistance: (from: THREE.Vector3, dir: THREE.Vector3) => number | null,
  opts: { mobile: boolean; reduceMotion: boolean },
) {
  const group = new THREE.Group()
  group.name = 'atmosfera'
  const time = { value: 0 }

  // ---------------------------------------------------------------- coni di luce
  const beams: Beam[] = []
  for (const s of manifest.spots) {
    const main = s.name.startsWith('Faretto_')
    const back = s.name.startsWith('Controluce_')
    const gain = main ? 1 : back ? 0.45 : 0.32
    const pos = new THREE.Vector3(...(s.pos as [number, number, number]))
    const dir = new THREE.Vector3(...(s.dir as [number, number, number])).normalize()
    const half = THREE.MathUtils.degToRad(s.angle) / 2
    const blend = s.blend ?? 0.5
    const length = hitDistance(pos, dir) ?? pos.y / Math.max(-dir.y, 0.2)
    beams.push({
      pos,
      dir,
      cosOuter: Math.cos(half),
      cosInner: Math.cos(half * (1 - blend)),
      length,
      gain,
      color: new THREE.Color(...(s.color as [number, number, number])),
    })
  }

  const camPos = { value: new THREE.Vector3() }
  const beamMat = (b: Beam) =>
    new THREE.ShaderMaterial({
      uniforms: { uColor: { value: b.color }, uGain: { value: 0.13 * b.gain }, uTime: time, uCam: camPos, uLen: { value: b.length } },
      vertexShader: /* glsl */ `
        uniform float uLen;
        varying vec3 vW; varying vec3 vN; varying float vT;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          vN = normalize(mat3(modelMatrix) * normal);
          vT = -position.y / uLen; // 0 al faretto, 1 sul soggetto
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uGain; uniform float uTime; uniform vec3 uCam;
        varying vec3 vW; varying vec3 vN; varying float vT;
        ${NOISE}
        void main() {
          vec3 V = normalize(uCam - vW);
          float facing = abs(dot(normalize(vN), V));
          float core = pow(facing, 1.3) * smoothstep(0.0, 0.25, facing);
          float along = smoothstep(0.0, 0.18, vT) * (1.0 - smoothstep(0.62, 1.0, vT)) * (1.15 - 0.5 * vT);
          float n = 0.62 + 0.76 * fbm(vW * 3.2 + vec3(0.0, -uTime * 0.035, uTime * 0.012));
          gl_FragColor = vec4(uColor * (uGain * core * along * n), 1.0);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.FrontSide,
    })

  for (const b of beams) {
    const r0 = 0.03
    const r1 = r0 + Math.tan(Math.acos(b.cosOuter)) * b.length
    // cono lungo -Y dal faretto al soggetto
    const g = new THREE.CylinderGeometry(r0, r1, b.length, 48, 1, true)
    g.translate(0, -b.length / 2, 0)
    const m = new THREE.Mesh(g, beamMat(b))
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), b.dir)
    m.position.copy(b.pos)
    m.renderOrder = 2
    m.frustumCulled = false
    group.add(m)
  }

  // ---------------------------------------------------------------- pulviscolo
  // concentrato attorno ai coni (li' brilla), rado nel resto della sala
  const N = opts.mobile ? 520 : 1100
  const seeds = new Float32Array(N * 4)
  const base = new Float32Array(N * 3)
  const rnd = mulberry32(7)
  const v = new THREE.Vector3()
  for (let i = 0; i < N; i++) {
    const inBeam = i < N * 0.72
    if (inBeam) {
      const b = beams[Math.floor(rnd() * Math.min(beams.length, 6))]
      const t = 0.12 + rnd() * 0.8
      const rr = Math.tan(Math.acos(b.cosOuter)) * b.length * t * Math.sqrt(rnd()) * 1.3
      const a = rnd() * Math.PI * 2
      // base ortonormale attorno all'asse del cono
      const ax = b.dir
      const ux = new THREE.Vector3(1, 0, 0).cross(ax).normalize()
      const uy = ax.clone().cross(ux)
      v.copy(b.pos).addScaledVector(ax, b.length * t).addScaledVector(ux, Math.cos(a) * rr).addScaledVector(uy, Math.sin(a) * rr)
    } else {
      v.set(-2.6 + rnd() * 4.6, 0.3 + rnd() * 3.2, -1.0 - rnd() * 6.2)
    }
    base.set([v.x, v.y, v.z], i * 3)
    seeds.set([rnd(), rnd(), rnd(), 0.5 + rnd()], i * 4)
  }
  const pg = new THREE.BufferGeometry()
  pg.setAttribute('position', new THREE.BufferAttribute(base, 3))
  pg.setAttribute('seed', new THREE.BufferAttribute(seeds, 4))
  const MAXB = 9
  const bPos = Array.from({ length: MAXB }, (_, i) => beams[i]?.pos ?? new THREE.Vector3(0, -99, 0))
  const bDir = Array.from({ length: MAXB }, (_, i) => beams[i]?.dir ?? new THREE.Vector3(0, -1, 0))
  const bCone = Array.from({ length: MAXB }, (_, i) =>
    beams[i] ? new THREE.Vector4(beams[i].cosOuter, beams[i].cosInner, beams[i].gain, beams[i].length) : new THREE.Vector4(2, 2, 0, 0),
  )
  const dustMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: time,
      uPx: { value: 1 },
      uBPos: { value: bPos },
      uBDir: { value: bDir },
      uBCone: { value: bCone },
      uDpr: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute vec4 seed;
      uniform float uTime; uniform float uPx; uniform float uDpr;
      uniform vec3 uBPos[${MAXB}]; uniform vec3 uBDir[${MAXB}]; uniform vec4 uBCone[${MAXB}];
      varying float vA;
      void main() {
        float t = uTime * (0.6 + 0.4 * seed.w);
        vec3 p = position;
        // deriva lenta: piccoli giri e una salita appena percettibile, ciclica
        p += vec3(sin(t * 0.13 + seed.x * 40.0), 0.0, cos(t * 0.11 + seed.y * 40.0)) * 0.05;
        p.y += mod(t * 0.006 + seed.z * 0.24, 0.24) - 0.12 + sin(t * 0.2 + seed.x * 9.0) * 0.015;
        float lit = 0.0;
        for (int i = 0; i < ${MAXB}; i++) {
          vec3 d = p - uBPos[i];
          float along = dot(d, uBDir[i]);
          float c = along / max(length(d), 1e-4);
          lit += smoothstep(uBCone[i].x, mix(uBCone[i].x, uBCone[i].y, 0.6), c) * uBCone[i].z
               * step(0.0, along) * (1.0 - smoothstep(uBCone[i].w - 0.05, uBCone[i].w + 0.02, along));
        }
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float dist = -mv.z;
        // scintillio: le particelle ruotano e catturano la luce a tratti
        float tw = 0.55 + 0.45 * sin(uTime * (1.3 + seed.y * 2.0) + seed.x * 31.0);
        vA = (0.035 + 0.9 * min(lit, 1.2) * tw) * smoothstep(0.18, 0.5, dist) * (1.0 - smoothstep(7.0, 10.0, dist));
        float size = 0.0011 * uPx / dist;
        gl_PointSize = clamp(size, 1.0 * uDpr, 3.2 * uDpr);
        vA *= min(size / uDpr, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.0, length(c));
        gl_FragColor = vec4(vec3(1.0, 0.94, 0.84) * a * vA * 0.55, 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const dust = new THREE.Points(pg, dustMat)
  dust.frustumCulled = false
  dust.renderOrder = 3
  group.add(dust)

  // ---------------------------------------------------------------- vapore dell'espresso
  // centro della crema: riferimento del vassoio sulla panca (vedi BDA_Galleria_Demo/scripts/build_scene.py)
  const steam = new THREE.Group()
  {
    const rb = 6.71
    const a = Math.asin(-1.4 / rb)
    const rz = -a
    const lx = -0.065
    const ly = 0.005
    const bx = rb * Math.sin(a) + lx * Math.cos(rz) - ly * Math.sin(rz)
    const by = rb * Math.cos(a) + lx * Math.sin(rz) + ly * Math.cos(rz)
    steam.position.set(bx, 0.44 + 0.0565, -by)
  }
  const steamGeo = new THREE.PlaneGeometry(0.085, 0.13, 1, 1)
  steamGeo.translate(0, 0.063, 0)
  for (let i = 0; i < 3; i++) {
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: time, uSeed: { value: i * 3.7 + 1.3 }, uOpacity: { value: i === 0 ? 0.2 : 0.14 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uSeed; uniform float uOpacity;
        varying vec2 vUv;
        ${NOISE}
        void main() {
          float t = uTime * 0.11 + uSeed;
          float y = vUv.y;
          float x = vUv.x - 0.5;
          // il filo sale, ondeggia e si allarga; in alto si sfilaccia e scompare
          float sway = (fbm(vec3(y * 1.6 - t * 1.3, uSeed, 0.0)) - 0.5) * 0.55 * y;
          float width = mix(0.09, 0.42, y);
          float body = 1.0 - smoothstep(0.0, width, abs(x - sway));
          float n = fbm(vec3(x * 6.0 + sway * 4.0, y * 3.4 - t * 2.4, uSeed));
          float wisps = smoothstep(0.45, 0.9, n);
          float fy = smoothstep(0.0, 0.2, y) * (1.0 - smoothstep(0.25, 0.95, y));
          float a = body * wisps * fy * uOpacity;
          gl_FragColor = vec4(vec3(1.0, 0.985, 0.96), a);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const p = new THREE.Mesh(steamGeo, m)
    p.position.set((i - 1) * 0.006, 0, (i % 2) * 0.004)
    p.renderOrder = 4
    steam.add(p)
  }
  group.add(steam)

  const tmp = new THREE.Vector3()
  function update(t: number, camera: THREE.Camera, pxPerUnit: number, dpr: number) {
    time.value = opts.reduceMotion ? 12.0 : t
    camPos.value.copy(camera.position)
    dustMat.uniforms.uPx.value = pxPerUnit
    dustMat.uniforms.uDpr.value = dpr
    // vapore: piani sempre rivolti alla camera attorno alla verticale
    steam.getWorldPosition(tmp)
    const ang = Math.atan2(camera.position.x - tmp.x, camera.position.z - tmp.z)
    steam.children.forEach((c, i) => (c.rotation.y = ang + (i - 1) * 0.5))
  }

  return { group, update }
}

function mulberry32(a: number) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
