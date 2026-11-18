import '@fontsource/cormorant-garamond/500.css'
import '@fontsource/cormorant-garamond/latin-500-italic.css'
import '@fontsource/jost/400.css'
import './style.css'

import * as THREE from 'three'
import Lenis from 'lenis'
import { loadGallery } from './scene'
import { createLoader } from './loader'
import { createPost } from './post'
import { createAtmosphere } from './atmosphere'
import { buildPath, verticalFov, STATIONS, CAFE_FRAME, type CamState } from './camera-path'
import { createUI } from './ui'

const canvas = document.querySelector<HTMLCanvasElement>('#gl')!
const sections = [...document.querySelectorAll<HTMLElement>('[data-station]')]
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
const mobile = matchMedia('(max-width: 820px), (pointer: coarse)').matches
const loader = createLoader(document.querySelector<HTMLElement>('#loader')!, reduceMotion)

// ---------------------------------------------------------------- scroll morbido
const lenis = new Lenis({ lerp: reduceMotion ? 1 : 0.085, smoothWheel: !reduceMotion })
lenis.stop() // niente scorrimento sotto il sipario
const ui = createUI({ sections, lenis, reduceMotion, mobile })

function revealPage() {
  document.body.classList.remove('is-loading')
  lenis.start()
}

function showFallback() {
  loader.fail()
  document.body.classList.add('no-webgl')
  revealPage()
}

/** posizione continua tra le stazioni: 0 = ingresso, N-1 = visita.
 *  Ogni sezione "possiede" la camera quando il suo centro attraversa il centro dello schermo. */
function scrollToU(): number {
  const mid = window.innerHeight / 2
  const centers = sections.map((s) => {
    const r = s.getBoundingClientRect()
    return r.top + r.height / 2
  })
  if (mid <= centers[0]) return 0
  for (let i = 0; i < centers.length - 1; i++) {
    if (mid <= centers[i + 1]) return i + (mid - centers[i]) / (centers[i + 1] - centers[i])
  }
  return centers.length - 1
}

// ---------------------------------------------------------------- three.js
async function start() {
  let renderer: THREE.WebGLRenderer
  try {
    // l'antialiasing lo fa il render target MSAA della post-produzione
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' })
  } catch {
    showFallback()
    return
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace
  // il tonemapping AgX e' gia' nelle texture cotte: niente tone mapping a runtime
  renderer.toneMapping = THREE.NoToneMapping
  const maxDpr = mobile ? 1.75 : 2
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxDpr))

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x1d1914)
  const camera = new THREE.PerspectiveCamera(40, 1, 0.02, 60)

  const gallery = await loadGallery(
    renderer,
    // gli ultimi punti percentuali coprono la compilazione degli shader
    (p) => loader.progress(p * 0.9),
    mobile,
  )
  scene.add(gallery.root)
  const params = new URLSearchParams(location.search)
  if (params.has('normals')) {
    const nm = new THREE.MeshNormalMaterial()
    gallery.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = nm
    })
  }
  // ?u=3.0 fissa la camera su una stazione (verifica delle inquadrature)
  const fixedU = params.has('u') ? parseFloat(params.get('u')!) : null
  gallery.root.updateMatrixWorld(true)
  const ray = new THREE.Raycaster()
  const hitDistance = (from: THREE.Vector3, dir: THREE.Vector3) => {
    ray.set(from, dir)
    ray.far = 20
    const hit = ray.intersectObject(gallery.root, true)[0]
    return hit ? hit.distance : null
  }
  let path = buildPath(gallery.manifest, hitDistance)
  if (path.stationCount !== STATIONS.length) console.warn('stazioni', path.stationCount)

  const atmosphere = params.has('noatmo') ? null : createAtmosphere(gallery.manifest, hitDistance, { mobile, reduceMotion })
  if (atmosphere) scene.add(atmosphere.group)

  const mkState = (): CamState => ({ pos: new THREE.Vector3(), target: new THREE.Vector3(), lens: 32, shiftY: 0, fstop: 11, focus: 3, portraitYaw: 0, portraitLens: 1 })
  const state = mkState()
  const cur = mkState()
  const snap = (u: number) => {
    path.sample(u, state)
    cur.pos.copy(state.pos)
    cur.target.copy(state.target)
    cur.lens = state.lens
    cur.shiftY = state.shiftY
    cur.fstop = state.fstop
    cur.focus = state.focus
    cur.portraitYaw = state.portraitYaw
    cur.portraitLens = state.portraitLens
  }
  snap(fixedU ?? scrollToU())

  const post = createPost(renderer, { mobile, debug: params.get('debug') })
  const focusUv = new THREE.Vector2(0.5, 0.5)
  let shiftNdc = 0
  let resetFocus = true

  /** raggio dello sfocato all'infinito (pixel): sotto il mezzo pixel la profondita' di campo non serve */
  function backgroundBlurPx(heightPx: number) {
    const f = lensNow / 1000
    const s = Math.max(cur.focus, f * 1.5)
    const sensorH = 2 * f * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
    return (0.5 * ((f / Math.max(cur.fstop, 1)) * f)) / (s - f) / sensorH * heightPx
  }

  // leggero parallasse col puntatore (solo desktop)
  const pointer = new THREE.Vector2()
  const pointerS = new THREE.Vector2()
  if (!mobile && !reduceMotion) {
    window.addEventListener('pointermove', (e) => {
      pointer.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1)
    })
  }

  let pxW = 1
  let pxH = 1
  function resize() {
    ui.measure()
    const w = window.innerWidth
    const h = window.innerHeight
    renderer.setSize(w, h, false)
    pxW = Math.round(w * renderer.getPixelRatio())
    pxH = Math.round(h * renderer.getPixelRatio())
    post.setSize(pxW, pxH)
    camera.aspect = w / h
  }
  window.addEventListener('resize', resize)
  resize()

  const right = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const tmp = new THREE.Vector3()
  const look = new THREE.Vector3()
  let lensNow = 32 // focale effettiva (intro e schermi verticali compresi)
  // carrellata d'ingresso: parte solo se la pagina si apre dall'inizio (vedi applyCamera)
  let introAt = -1
  const introWanted = !reduceMotion && fixedU === null && scrollToU() < 0.3

  function applyCamera(t: number) {
    camera.position.copy(cur.pos)
    const dist = cur.pos.distanceTo(cur.target)
    // parallasse: piccolo spostamento laterale/verticale, proporzionale al campo inquadrato
    const reach = 0.012 * (32 / cur.lens) * dist
    tmp.copy(cur.target).sub(cur.pos).normalize()
    right.crossVectors(tmp, up).normalize()
    camera.position.addScaledVector(right, pointerS.x * reach).addScaledVector(up, -pointerS.y * reach * 0.6)
    // ingresso: mentre il sipario si alza la camera avanza di qualche passo verso il portale
    let introZoom = 1
    if (introAt >= 0) {
      // (l'anticamera e' profonda: indietro di poco, il resto lo fa l'ottica che si apre)
      const p = THREE.MathUtils.clamp((performance.now() - introAt) / 4600, 0, 1)
      const e = 1 - Math.pow(1 - p, 3)
      camera.position.addScaledVector(tmp, -0.32 * (1 - e)).addScaledVector(up, 0.05 * (1 - e))
      introZoom = 1 + 0.22 * (1 - e)
      if (p >= 1) introAt = -1
    }
    // respiro: deriva lentissima, come una camera a mano ferma
    if (!reduceMotion) {
      const b = 0.0035 * (32 / cur.lens) * dist
      camera.position
        .addScaledVector(right, Math.sin(t * 0.31) * b + Math.sin(t * 0.83 + 1.7) * b * 0.25)
        .addScaledVector(up, Math.sin(t * 0.23 + 0.6) * b * 0.55)
    }
    camera.up.set(0, 1, 0)
    // schermi verticali: dove serve la camera ruota verso il soggetto principale
    if (camera.aspect < 1 && cur.portraitYaw !== 0) {
      const yaw = THREE.MathUtils.degToRad(cur.portraitYaw) * THREE.MathUtils.clamp((1 - camera.aspect) / 0.55, 0, 1)
      look.copy(cur.target).sub(camera.position).applyAxisAngle(up, yaw).add(camera.position)
      camera.lookAt(look)
    } else camera.lookAt(cur.target)
    const portrait = THREE.MathUtils.clamp((1 - camera.aspect) / 0.55, 0, 1)
    lensNow = cur.lens * introZoom * (1 + (cur.portraitLens - 1) * portrait)
    camera.fov = verticalFov(lensNow, camera.aspect)
    camera.updateProjectionMatrix()
    // shift ottico verticale come in Blender (frazione della dimensione maggiore del sensore)
    // in verticale il testo occupa la parte bassa: il soggetto sale verso il terzo superiore
    const portraitLift = camera.aspect < 1 ? -0.55 * (1 - camera.aspect) : 0
    shiftNdc = 2 * cur.shiftY * Math.max(camera.aspect, 1) + portraitLift
    camera.projectionMatrix.elements[9] += shiftNdc
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
    // l'asse ottico cade qui sullo schermo: e' il punto che l'autofocus misura
    focusUv.set(0.5, THREE.MathUtils.clamp(0.5 - shiftNdc / 2, 0.1, 0.9))
  }

  function draw(u: number, dt: number, t: number) {
    const f = lensNow / 1000
    const sensorH = 2 * f * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
    // vicino a una stazione vale la messa a fuoco di Blender, nei tragitti l'autofocus
    const ds = Math.abs(u - Math.round(u))
    const stationWeight = fixedU !== null ? 1 : 1 - THREE.MathUtils.smoothstep(ds, 0.1, 0.32)
    if (atmosphere) {
      const pxPerUnit = pxH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))
      atmosphere.update(t, camera, pxPerUnit, renderer.getPixelRatio())
    }
    post.render(scene, camera, {
      focusKeyed: cur.focus,
      stationWeight,
      lensMm: lensNow,
      fstop: cur.fstop,
      sensorH,
      focusUv,
      dofOn: !params.has('nodof') && backgroundBlurPx(pxH) > 0.6,
      dt,
      time: t,
      reset: resetFocus,
    })
    resetFocus = false
  }

  if (import.meta.env.DEV) {
    ;(window as any).__dbg = { scene, camera, post, atmosphere, cur }
    ;(window as any).__reframe = (o: Partial<typeof CAFE_FRAME>) => {
      Object.assign(CAFE_FRAME, o)
      path = buildPath(gallery.manifest, hitDistance)
      return JSON.stringify(CAFE_FRAME)
    }
    // verifica visiva: renderizza la stazione u e salva il fotogramma via dev server
    ;(window as any).__shot = async (u: number, name: string, w = 1600, h = 900) => {
      renderer.setPixelRatio(1)
      renderer.setSize(w, h, false)
      pxW = w
      pxH = h
      post.setSize(w, h)
      camera.aspect = w / h
      snap(u)
      pointerS.set(0, 0)
      applyCamera(0)
      resetFocus = true
      draw(u, 1 / 60, 0)
      const data = canvas.toDataURL('image/jpeg', 0.92)
      await fetch('/__shot?name=' + encodeURIComponent(name), { method: 'POST', body: data })
      renderer.setPixelRatio(dpr)
      resize()
      return 'ok ' + name + ' focus=' + cur.focus.toFixed(3) + ' lens=' + cur.lens.toFixed(1) + ' f=' + cur.fstop.toFixed(1) + ' blur=' + backgroundBlurPx(h).toFixed(1)
    }
  }

  let last = performance.now()
  const t0 = last
  let firstFrame = true

  // risoluzione adattiva: se la GPU non regge, il pixel ratio scende a gradini (e risale se c'e' margine)
  const dprMax = Math.min(window.devicePixelRatio, maxDpr)
  let dpr = dprMax
  let acc = 0
  let frames = 0
  let settle = 2 // secondi da ignorare (compilazione, caricamento texture)
  function adapt(dt: number) {
    settle -= dt
    if (settle > 0 || document.hidden) return
    acc += dt
    frames++
    if (acc < 1.5) return
    const ms = (acc / frames) * 1000
    acc = 0
    frames = 0
    let next = dpr
    if (ms > 24 && dpr > 1) next = Math.max(1, dpr - 0.25)
    else if (ms < 13 && dpr < dprMax) next = Math.min(dprMax, dpr + 0.25)
    if (next !== dpr) {
      dpr = next
      renderer.setPixelRatio(dpr)
      resize()
      settle = 1
    }
  }

  function frame(now: number) {
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    if (!firstFrame) adapt(dt)
    const t = (now - t0) / 1000
    lenis.raf(now)
    const u = fixedU ?? scrollToU()
    ui.update(u, t)
    path.sample(u, state)
    // smorzamento: la camera "insegue" il percorso, niente scatti con la rotella
    const k = reduceMotion ? 1 : 1 - Math.exp(-dt * 5.5)
    cur.pos.lerp(state.pos, k)
    cur.target.lerp(state.target, k)
    cur.lens += (state.lens - cur.lens) * k
    cur.shiftY += (state.shiftY - cur.shiftY) * k
    cur.fstop += (state.fstop - cur.fstop) * k
    cur.focus += (state.focus - cur.focus) * k
    cur.portraitYaw += (state.portraitYaw - cur.portraitYaw) * k
    cur.portraitLens += (state.portraitLens - cur.portraitLens) * k
    pointerS.lerp(pointer, 1 - Math.exp(-dt * 3))

    applyCamera(t)
    draw(u, dt, t)
    if (firstFrame) {
      firstFrame = false
      canvas.classList.add('on')
      // la pagina entra mentre il sipario si alza (la camera era gia' indietro di qualche passo)
      if (introWanted) introAt = performance.now() + 1e9
      loader.finish().then(() => {
        if (introWanted) introAt = performance.now()
        revealPage()
      })
    }
    requestAnimationFrame(frame)
  }
  // compila gli shader prima del primo fotogramma visibile
  await renderer.compileAsync(scene, camera)
  loader.progress(0.97)
  requestAnimationFrame(frame)
}

ui.update(0, 0)
start().catch((err) => {
  console.error(err)
  showFallback()
})
