import '@fontsource/cormorant-garamond/500.css'
import '@fontsource/jost/400.css'
import './style.css'

import * as THREE from 'three'
import Lenis from 'lenis'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { loadGallery } from './scene'
import { buildPath, verticalFov, STATIONS, type CamState } from './camera-path'

const canvas = document.querySelector<HTMLCanvasElement>('#gl')!
const poster = document.querySelector<HTMLImageElement>('#poster')!
const loader = document.querySelector<HTMLElement>('#loader')!
const bar = loader.querySelector<HTMLElement>('.loader-bar i')!
const sections = [...document.querySelectorAll<HTMLElement>('[data-station]')]
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
const mobile = matchMedia('(max-width: 820px), (pointer: coarse)').matches

// ---------------------------------------------------------------- scroll morbido
const lenis = new Lenis({ lerp: reduceMotion ? 1 : 0.085, smoothWheel: !reduceMotion })
document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) =>
  a.addEventListener('click', (e) => {
    const el = document.querySelector<HTMLElement>(a.getAttribute('href')!)
    if (!el) return
    e.preventDefault()
    lenis.scrollTo(el, { duration: 2.4 })
  }),
)

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

function updateUI(u: number) {
  sections.forEach((s, i) => {
    const d = Math.abs(u - i)
    s.style.setProperty('--vis', String(THREE.MathUtils.clamp(1.6 - d * 2.2, 0, 1)))
  })
  // menu chiaro nell'anticamera (inizio e fine), scuro sulle pareti chiare della sala
  document.body.classList.toggle('past-hero', u > 0.35 && u < sections.length - 1.45)
}

// ---------------------------------------------------------------- three.js
async function start() {
  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
  } catch {
    loader.classList.add('done')
    document.body.classList.add('no-webgl')
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
    (p) => {
      bar.style.transform = `scaleX(${p.toFixed(3)})`
    },
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
  const path = buildPath(gallery.manifest, (from, dir) => {
    ray.set(from, dir)
    ray.far = 20
    const hit = ray.intersectObject(gallery.root, true)[0]
    return hit ? hit.distance : null
  })
  if (path.stationCount !== STATIONS.length) console.warn('stazioni', path.stationCount)

  const state: CamState = { pos: new THREE.Vector3(), target: new THREE.Vector3(), lens: 32, shiftY: 0, fstop: 11, focus: 3 }
  const cur: CamState = { pos: new THREE.Vector3(), target: new THREE.Vector3(), lens: 32, shiftY: 0, fstop: 11, focus: 3 }
  path.sample(scrollToU(), state)
  cur.pos.copy(state.pos)
  cur.target.copy(state.target)
  cur.lens = state.lens
  cur.shiftY = state.shiftY
  cur.fstop = state.fstop
  cur.focus = state.focus

  // ---- profondita' di campo (solo quando serve: macro sui dolci)
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 })
  const composer = new EffectComposer(renderer, rt)
  composer.addPass(new RenderPass(scene, camera))
  const bokeh = new BokehPass(scene, camera, { focus: 1, aperture: 0, maxblur: 0.02 })
  composer.addPass(bokeh)
  composer.addPass(new OutputPass())
  const bokehU = bokeh.uniforms as Record<string, THREE.IUniform>
  /** parametri del BokehShader dalla fisica della lente (frazioni della larghezza immagine):
   *  aperture = cerchio di confusione per metro di defocus vicino al piano di fuoco,
   *  maxblur  = cerchio di confusione all'infinito (limite fisico dello sfocato di fondo) */
  function dofParams() {
    const f = cur.lens / 1000
    const A = f / Math.max(cur.fstop, 1)
    const s = Math.max(cur.focus, f * 1.5)
    const toUv = (coc: number) => (coc / 0.036 / 2 / 0.4) * (camera.aspect < 1 ? 1 / camera.aspect : 1)
    return { ap: toUv((A * f) / (s * (s - f))), maxb: Math.min(toUv((A * f) / (s - f)), 0.013) }
  }

  // leggero parallasse col puntatore (solo desktop)
  const pointer = new THREE.Vector2()
  const pointerS = new THREE.Vector2()
  if (!mobile && !reduceMotion) {
    window.addEventListener('pointermove', (e) => {
      pointer.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1)
    })
  }

  function resize() {
    // altezza reale dei pannelli: serve al CSS per centrarli verticalmente
    document.querySelectorAll<HTMLElement>('.panel .copy').forEach((c) => c.style.setProperty('--h', c.offsetHeight + 'px'))
    const w = window.innerWidth
    const h = window.innerHeight
    renderer.setSize(w, h, false)
    composer.setPixelRatio(renderer.getPixelRatio())
    composer.setSize(w, h)
    camera.aspect = w / h
  }
  window.addEventListener('resize', resize)
  resize()

  function draw() {
    const d = dofParams()
    if (d.maxb > 0.002 && !params.has('nodof')) {
      bokehU.focus.value = cur.focus
      bokehU.aperture.value = d.ap
      bokehU.maxblur.value = d.maxb
      bokehU.aspect.value = camera.aspect
      composer.render()
    } else {
      renderer.render(scene, camera)
    }
  }

  function applyCamera() {
    camera.position.copy(cur.pos)
    // parallasse: piccolo spostamento laterale/verticale, proporzionale al campo inquadrato
    const reach = 0.012 * (32 / cur.lens) * cur.pos.distanceTo(cur.target)
    tmp.copy(cur.target).sub(cur.pos).normalize()
    right.crossVectors(tmp, up).normalize()
    camera.position.addScaledVector(right, pointerS.x * reach).addScaledVector(up, -pointerS.y * reach * 0.6)
    camera.up.set(0, 1, 0)
    camera.lookAt(cur.target)
    camera.fov = verticalFov(cur.lens, camera.aspect)
    camera.updateProjectionMatrix()
    // shift ottico verticale come in Blender (frazione della dimensione maggiore del sensore)
    // in verticale il testo occupa la parte bassa: il soggetto sale verso il terzo superiore
    const portraitLift = camera.aspect < 1 ? -0.55 * (1 - camera.aspect) : 0
    const shiftNdc = 2 * cur.shiftY * Math.max(camera.aspect, 1) + portraitLift
    camera.projectionMatrix.elements[9] += shiftNdc
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()

  }

  if (import.meta.env.DEV) {
    // verifica visiva: renderizza la stazione u e salva il fotogramma via dev server
    ;(window as any).__shot = async (u: number, name: string, w = 1600, h = 900) => {
      renderer.setPixelRatio(1)
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      path.sample(u, state)
      cur.pos.copy(state.pos); cur.target.copy(state.target); cur.lens = state.lens; cur.shiftY = state.shiftY
      cur.fstop = state.fstop; cur.focus = state.focus
      pointerS.set(0, 0)
      composer.setSize(w, h)
      applyCamera()
      draw()
      const data = canvas.toDataURL('image/jpeg', 0.9)
      await fetch('/__shot?name=' + encodeURIComponent(name), { method: 'POST', body: data })
      resize()
      return 'ok ' + name + ' focus=' + cur.focus.toFixed(3) + ' lens=' + cur.lens.toFixed(1) + ' f=' + cur.fstop.toFixed(1) + ' dof=' + JSON.stringify(dofParams())
    }
  }

  const right = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const tmp = new THREE.Vector3()
  let last = performance.now()
  let firstFrame = true

  function frame(now: number) {
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    lenis.raf(now)
    const u = fixedU ?? scrollToU()
    updateUI(u)
    path.sample(u, state)
    // smorzamento: la camera "insegue" il percorso, niente scatti con la rotella
    const k = reduceMotion ? 1 : 1 - Math.exp(-dt * 5.5)
    cur.pos.lerp(state.pos, k)
    cur.target.lerp(state.target, k)
    cur.lens += (state.lens - cur.lens) * k
    cur.shiftY += (state.shiftY - cur.shiftY) * k
    cur.fstop += (state.fstop - cur.fstop) * k
    cur.focus += (state.focus - cur.focus) * k
    pointerS.lerp(pointer, 1 - Math.exp(-dt * 3))

    applyCamera()
    draw()
    if (firstFrame) {
      firstFrame = false
      requestAnimationFrame(() => {
        loader.classList.add('done')
        canvas.classList.add('on')
        setTimeout(() => poster.classList.add('off'), 1200)
      })
    }
    requestAnimationFrame(frame)
  }
  // compila gli shader prima del primo fotogramma visibile
  await renderer.compileAsync(scene, camera)
  requestAnimationFrame(frame)
}

updateUI(0)
start().catch((err) => {
  console.error(err)
  loader.classList.add('done')
  document.body.classList.add('no-webgl')
})
