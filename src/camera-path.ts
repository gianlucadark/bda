import * as THREE from 'three'
import type { Manifest } from './scene'

/**
 * Percorso della camera guidato dallo scroll.
 * Le "stazioni" sono le inquadrature progettate in Blender (stesse ottiche e shift),
 * i punti intermedi tengono il percorso fuori da pareti e piedistalli.
 * Coordinate dei punti intermedi: Blender (Z-up), convertite qui.
 */

export interface CamState {
  pos: THREE.Vector3
  target: THREE.Vector3
  lens: number // mm su sensore 36 mm orizzontale
  shiftY: number
  fstop: number
  focus: number // distanza di messa a fuoco (m)
}

interface Key {
  pos: THREE.Vector3
  target: THREE.Vector3
  lens: number
  shiftY: number
  fstop: number
  focus?: number
  station?: string
}

const b2t = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y)

export const STATIONS = [
  'ingresso',
  'sala',
  'creazioni',
  'cupola',
  'strati',
  'tartelletta',
  'caffe',
  'riconoscimenti',
  'visita',
] as const
export type Station = (typeof STATIONS)[number]

export function buildPath(m: Manifest, focusAt: (from: THREE.Vector3, dir: THREE.Vector3) => number | null) {
  const C = m.cameras
  const fromCam = (name: string, station?: Station, override?: Partial<Key>): Key => {
    const c = C[name]
    const pos = new THREE.Vector3(...(c.pos as [number, number, number]))
    const tgt = new THREE.Vector3(...(c.target as [number, number, number]))
    // la camera Blender guarda lungo (target - pos) a 2 m: porto il target a 3 m per curve piu' morbide
    const dir = tgt.clone().sub(pos).normalize()
    return {
      pos,
      target: pos.clone().addScaledVector(dir, 3),
      lens: c.lens,
      shiftY: c.shift[1],
      fstop: c.fstop ?? 11,
      focus: c.focus ?? undefined, // messa a fuoco di Blender (centro del soggetto)
      station,
      ...override,
    }
  }
  const wp = (p: [number, number, number], t: [number, number, number], lens: number, shiftY = 0): Key => ({
    pos: b2t(...p),
    target: b2t(...t),
    lens,
    shiftY,
    fstop: 11,
  })

  const keys: Key[] = [
    fromCam('Cam_02_Ingresso', 'ingresso'),
    wp([0.58, -1.6, 1.52], [0.75, 5.0, 1.5], 28, 0.04),
    wp([0.5, -0.05, 1.5], [0.6, 5.0, 1.45], 24, 0.035),
    fromCam('Cam_01_Hero', 'sala'),
    wp([-0.35, 1.85, 1.48], [0.8, 4.6, 1.15], 30),
    fromCam('Cam_03_Creazioni', 'creazioni'),
    wp([0.9, 2.55, 1.46], [1.15, 3.5, 1.24], 60),
    fromCam('Cam_04b_Dettaglio_Cupola', 'cupola'),
    wp([0.78, 2.35, 1.42], [0.85, 3.2, 1.1], 70),
    fromCam('Cam_04_Dettaglio', 'strati'),
    wp([0.15, 2.6, 1.3], [0.2, 3.5, 0.95], 70),
    fromCam('Cam_04c_Dettaglio_Tartelletta', 'tartelletta'),
    wp([-0.45, 3.5, 1.2], [-1.2, 6.2, 0.6], 40),
    wp([-0.8, 4.9, 0.95], [-1.4, 6.5, 0.5], 50),
    fromCam('Cam_04d_Caffe', 'caffe'),
    wp([-0.4, 4.4, 1.4], [-2.5, 3.6, 1.45], 30),
    // come Cam_05 ma ruotata verso destra: le tavole occupano i 3/5 a sinistra, il testo sta a destra
    { ...wp([-0.3, 3.4, 1.55], [-3.75, 3.62, 1.55], 30, 0.05), fstop: 11, station: 'riconoscimenti' },
    wp([0.3, 1.4, 1.6], [0.5, 5.0, 1.6], 22, 0.03),
    wp([0.52, -1.2, 1.52], [0.65, 6.0, 1.5], 26, 0.04),
    {
      ...wp([0.55, -3.3, 1.45], [0.68, 6.0, 1.52], 27, 0.045),
      station: 'visita',
    },
  ]

  // messa a fuoco: raycast lungo l'asse ottico di ogni punto di controllo
  const dir = new THREE.Vector3()
  for (const k of keys) {
    dir.copy(k.target).sub(k.pos).normalize()
    if (k.focus === undefined) {
      const hit = focusAt(k.pos, dir)
      k.focus = hit === null ? 3 : hit + 0.03 // un poco oltre la superficie: verso il centro del soggetto
    }
  }

  const posCurve = new THREE.CatmullRomCurve3(keys.map((k) => k.pos), false, 'centripetal')
  const tgtCurve = new THREE.CatmullRomCurve3(keys.map((k) => k.target), false, 'centripetal')
  const n = keys.length - 1
  // indice (float) del punto di controllo di ogni stazione
  const stationIdx = keys.map((k, i) => (k.station ? i : -1)).filter((i) => i >= 0)

  const lerp = THREE.MathUtils.lerp
  const smooth = (x: number) => x * x * x * (x * (x * 6 - 15) + 10) // smootherstep: sosta sulle stazioni

  /** u in [0, STATIONS.length-1]: posizione tra le stazioni */
  function sample(u: number, out: CamState) {
    const s = THREE.MathUtils.clamp(u, 0, stationIdx.length - 1)
    const i = Math.min(Math.floor(s), stationIdx.length - 2)
    const f = smooth(s - i)
    const k = lerp(stationIdx[i], stationIdx[i + 1], f) // indice continuo nei keys
    const t = k / n
    posCurve.getPoint(t, out.pos)
    tgtCurve.getPoint(t, out.target)
    const ki = Math.min(Math.floor(k), n - 1)
    const kf = k - ki
    // l'ottica si interpola in "angolo di campo", non in mm
    const fa = Math.atan(18 / keys[ki].lens)
    const fb = Math.atan(18 / keys[ki + 1].lens)
    out.lens = 18 / Math.tan(lerp(fa, fb, kf))
    out.shiftY = lerp(keys[ki].shiftY, keys[ki + 1].shiftY, kf)
    out.fstop = lerp(keys[ki].fstop, keys[ki + 1].fstop, kf)
    out.focus = lerp(keys[ki].focus!, keys[ki + 1].focus!, kf)
    return out
  }

  return { sample, stationCount: stationIdx.length }
}

/** fov verticale per three.js a partire dall'ottica Blender (sensore 36 mm orizzontale) */
export function verticalFov(lens: number, aspect: number) {
  const ref = 16 / 9
  const tanH = 18 / lens
  const tanVRef = tanH / ref
  let tanV: number
  if (aspect >= ref) tanV = tanVRef
  else tanV = tanVRef * Math.pow(ref / aspect, 0.8) // schermi stretti: compromesso tra larghezza e altezza
  const v = 2 * Math.atan(tanV)
  return THREE.MathUtils.radToDeg(Math.min(v, THREE.MathUtils.degToRad(88)))
}
