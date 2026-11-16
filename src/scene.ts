import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

/**
 * La galleria arriva da Blender gia' "cotta": ogni gruppo di oggetti ha un atlante
 * con il risultato di Cycles (luce diretta, rimbalzi, ombre morbide, materiali
 * procedurali) e tonemapping AgX identico ai render. Nel browser quindi:
 *  - superfici opache  -> MeshBasicMaterial: il texel e' gia' il colore finale
 *  - superfici lucide  -> il colore cotto senza glossy + riflessi calcolati dal vivo
 *    da una sonda HDR catturata in Cycles, cosi' la glassa "si muove" con la camera
 */

export interface CamDef {
  pos: number[]
  target: number[]
  up: number[]
  lens: number
  sensor: number
  fit: string
  shift: number[]
  fstop: number | null
  focus?: number | null
}

interface MatParams { rough?: number; metal?: number; coat?: number; trans?: number; color?: number[] | null }
interface GroupDef { res: number; gloss: boolean; materials: Record<string, MatParams>; tris: number }
export interface Manifest {
  groups: Record<string, GroupDef>
  cameras: Record<string, CamDef>
  spots: { name: string; pos: number[]; dir: number[]; energy: number; color: number[]; angle: number }[]
}

const BASE = import.meta.env.BASE_URL + 'scene/'

export interface LoadedScene {
  root: THREE.Group
  manifest: Manifest
  glossMaterials: THREE.MeshPhysicalMaterial[]
}

export async function loadGallery(
  renderer: THREE.WebGLRenderer,
  onProgress: (p: number) => void,
  mobile: boolean,
): Promise<LoadedScene> {
  const manifest: Manifest = await (await fetch(BASE + 'manifest.json')).json()

  const groups = Object.keys(manifest.groups)
  // pesi di caricamento: GLB + env + una texture per gruppo (le 4K pesano di piu')
  const weights: Record<string, number> = { glb: 4, env: 1 }
  for (const g of groups) weights['tex:' + g] = manifest.groups[g].res >= 4096 ? 3 : 1
  const totalW = Object.values(weights).reduce((a, b) => a + b, 0)
  const done: Record<string, number> = {}
  const report = (k: string, f: number) => {
    done[k] = Math.max(done[k] ?? 0, f)
    let s = 0
    for (const key in weights) s += weights[key] * (done[key] ?? 0)
    onProgress(s / totalW)
  }

  const maxAniso = renderer.capabilities.getMaxAnisotropy()
  const texLoader = new THREE.TextureLoader()
  const loadTex = (g: string) =>
    new Promise<THREE.Texture>((resolve, reject) => {
      // su mobile le 4K diventano 2K (meta' risoluzione, stessa qualita' percepita su schermi piccoli)
      const file = mobile && manifest.groups[g].res >= 2048 ? `${g}_m.webp` : `${g}.webp`
      texLoader.load(
        BASE + 'tex/' + file,
        (t) => {
          t.flipY = false // convenzione glTF
          t.colorSpace = THREE.SRGBColorSpace
          t.anisotropy = maxAniso
          t.generateMipmaps = true
          t.minFilter = THREE.LinearMipmapLinearFilter
          t.magFilter = THREE.LinearFilter
          report('tex:' + g, 1)
          resolve(t)
        },
        undefined,
        () => {
          // texture mancante: grigio neutro, la scena resta navigabile
          console.warn('texture mancante', file)
          const t = new THREE.DataTexture(new Uint8Array([150, 140, 128, 255]), 1, 1)
          t.colorSpace = THREE.SRGBColorSpace
          t.needsUpdate = true
          report('tex:' + g, 1)
          resolve(t)
        },
      )
    })

  const gltfLoader = new GLTFLoader()
  gltfLoader.setMeshoptDecoder(MeshoptDecoder)
  const gltfP = gltfLoader.loadAsync(BASE + 'galleria.glb', (e) => {
    if (e.total) report('glb', e.loaded / e.total)
  })
  const envP = new HDRLoader().loadAsync(BASE + 'env.hdr').then((t) => {
    report('env', 1)
    return t
  })
  const texP = Promise.all(groups.map(async (g) => [g, await loadTex(g)] as const))

  const [gltf, envHdr, texList] = await Promise.all([gltfP, envP, texP])
  report('glb', 1)
  const tex = Object.fromEntries(texList)

  envHdr.mapping = THREE.EquirectangularReflectionMapping
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envMap = pmrem.fromEquirectangular(envHdr).texture
  envHdr.dispose()
  pmrem.dispose()

  // maschera del monogramma (alpha), usata sulla piastra cotta
  const monoMask = await texLoader.loadAsync(BASE + 'tex/mono_mask.png').catch(() => null)
  if (monoMask) {
    monoMask.flipY = false
    monoMask.colorSpace = THREE.NoColorSpace
  }

  const glossMaterials: THREE.MeshPhysicalMaterial[] = []
  const matCache = new Map<string, THREE.Material>()

  const makeMaterial = (name: string): THREE.Material => {
    const cached = matCache.get(name)
    if (cached) return cached
    const g = name.replace(/^G_/, '').split('__')[0]
    const def = manifest.groups[g]
    const map = tex[g]
    let m: THREE.Material
    const pGlass = def?.materials[name]
    if (def?.gloss && (pGlass?.trans ?? 0) > 0.5) {
      // vetro e liquido: trasmissione reale (rifrange la scena cotta che sta dietro).
      // Il bake "di fronte" non puo' rappresentare un materiale trasparente.
      const liquid = name.includes('Aperitivo')
      const c = pGlass?.color ?? [1, 1, 1]
      // il liquido resta opaco (rosso profondo, lucido): cosi' entra nel buffer che il vetro rifrange
      const gm = liquid
        ? new THREE.MeshPhysicalMaterial({
            color: new THREE.Color(c[0] * 0.32, c[1] * 0.1, c[2] * 0.1),
            roughness: 0.1,
            metalness: 0,
            envMap,
            envMapIntensity: 1.1,
            specularIntensity: 0.5,
            dithering: true,
          })
        : new THREE.MeshPhysicalMaterial({
            color: 0xffffff,
            transmission: 1,
            roughness: 0.02,
            metalness: 0,
            ior: 1.5,
            thickness: 0.003,
            envMap,
            envMapIntensity: 0.9,
            specularIntensity: 1,
            dithering: true,
          })
      gm.name = name
      matCache.set(name, gm)
      return gm
    }
    if (def?.gloss) {
      const p = def.materials[name] ?? {}
      const rough = THREE.MathUtils.clamp(p.rough ?? 0.3, 0.04, 1)
      const pm = new THREE.MeshPhysicalMaterial({
        color: 0x000000,
        emissive: 0xffffff,
        emissiveMap: map,
        roughness: rough,
        metalness: 0,
        envMap,
        envMapIntensity: 1,
        clearcoat: p.coat ?? 0,
        clearcoatRoughness: 0.06,
        dithering: true,
      })
      pm.userData.specGain = { value: 0.9 }
      pm.onBeforeCompile = (shader) => {
        shader.uniforms.uSpecGain = pm.userData.specGain
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uSpecGain;')
          .replace(
            '#include <opaque_fragment>',
            /* glsl */ `
            // il colore cotto e' gia' tonemappato: lo specular HDR live si somma con una
            // compressione morbida (screen) per non bruciare i bianchi
            vec3 bakedC = totalEmissiveRadiance;
            vec3 specC = max( outgoingLight - bakedC, vec3( 0.0 ) );
            outgoingLight = bakedC + ( 1.0 - bakedC ) * ( 1.0 - exp( -specC * uSpecGain ) );
            #include <opaque_fragment>`,
          )
      }
      pm.customProgramCacheKey = () => 'bda-gloss'
      glossMaterials.push(pm)
      m = pm
    } else if (g === 'mono') {
      m = new THREE.MeshBasicMaterial({
        map,
        alphaMap: monoMask ?? undefined,
        alphaTest: 0.5,
        transparent: false,
        dithering: true,
      })
    } else {
      m = new THREE.MeshBasicMaterial({ map, dithering: true })
    }
    m.name = name
    matCache.set(name, m)
    return m
  }

  const root = gltf.scene
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const next = mats.map((mm) => makeMaterial(mm.name))
    mesh.material = Array.isArray(mesh.material) ? next : next[0]
    mats.forEach((mm) => mm.dispose())
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
  })
  return { root, manifest, glossMaterials }
}
