import type Lenis from 'lenis'

/**
 * Strato di interfaccia sopra la galleria:
 *  - visibilita' dei pannelli legata alla posizione della camera (--vis) e rivelazione dei titoli
 *    parola per parola quando il pannello "prende" la scena
 *  - contatore dei capitoli con barra di avanzamento, cliccabile
 *  - indicazione di scorrimento nell'ingresso
 *  - cursore ad anello (solo puntatori fini)
 */

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))
const pad = (n: number) => String(n).padStart(2, '0')

function splitWords(el: HTMLElement) {
  if (el.dataset.split) return
  el.dataset.split = '1'
  const text = el.textContent ?? ''
  el.setAttribute('aria-label', text)
  el.textContent = ''
  text.split(/\s+/).filter(Boolean).forEach((w, i, all) => {
    const outer = document.createElement('span')
    outer.className = 'w'
    outer.setAttribute('aria-hidden', 'true')
    const inner = document.createElement('span')
    inner.textContent = w
    inner.style.setProperty('--i', String(i))
    outer.appendChild(inner)
    el.appendChild(outer)
    if (i < all.length - 1) el.appendChild(document.createTextNode(' '))
  })
}

export function createUI(o: { sections: HTMLElement[]; lenis: Lenis; reduceMotion: boolean; mobile: boolean }) {
  const { sections, lenis } = o
  const N = sections.length

  // ancore interne con lo scroll morbido
  const go = (el: HTMLElement) => lenis.scrollTo(el, { duration: 2.4, offset: 0 })
  document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) =>
    a.addEventListener('click', (e) => {
      const el = document.querySelector<HTMLElement>(a.getAttribute('href')!)
      if (!el) return
      e.preventDefault()
      go(el)
    }),
  )

  // titoli: parole mascherate che salgono; numero del capitolo come le didascalie in sala
  const labels: string[] = []
  sections.forEach((s, i) => {
    const h = s.querySelector<HTMLElement>('h1, h2')
    labels.push(i === 0 ? 'Ingresso' : (h?.textContent ?? '').trim())
    if (h) splitWords(h)
    const copy = s.querySelector<HTMLElement>('.copy')
    if (copy && i > 0) {
      const eb = document.createElement('p')
      eb.className = 'eyebrow'
      eb.setAttribute('aria-hidden', 'true')
      eb.innerHTML = `<span>${pad(i + 1)} / ${pad(N)}</span>`
      copy.prepend(eb)
    }
  })

  // contatore dei capitoli
  const hud = document.createElement('nav')
  hud.className = 'hud'
  hud.setAttribute('aria-label', 'Capitoli')
  hud.innerHTML = `
    <span class="hud-count" aria-hidden="true"><span class="hud-cur"><span>01</span></span><i></i><span class="hud-tot">${pad(N)}</span></span>
    <span class="hud-label" aria-hidden="true"><span>${labels[0]}</span></span>
    <span class="hud-line" aria-hidden="true"><i></i></span>
    <ol class="hud-ticks">${sections
      .map((s, i) => `<li><button type="button" data-i="${i}" aria-label="${labels[i]}"><span></span></button></li>`)
      .join('')}</ol>`
  document.body.appendChild(hud)
  const curEl = hud.querySelector<HTMLElement>('.hud-cur')!
  const labelEl = hud.querySelector<HTMLElement>('.hud-label')!
  const fill = hud.querySelector<HTMLElement>('.hud-line i')!
  const ticks = [...hud.querySelectorAll<HTMLButtonElement>('.hud-ticks button')]
  ticks.forEach((b) => b.addEventListener('click', () => go(sections[+b.dataset.i!])))

  // invito a scorrere, solo nell'ingresso
  const cue = document.createElement('div')
  cue.className = 'scroll-cue'
  cue.setAttribute('aria-hidden', 'true')
  cue.innerHTML = '<span>Scorri</span><i></i>'
  document.body.appendChild(cue)

  // cursore
  const fine = matchMedia('(hover: hover) and (pointer: fine)').matches && !o.mobile
  let cursor: HTMLElement | null = null
  const cp = { x: -100, y: -100, tx: -100, ty: -100, s: 1, ts: 1 }
  if (fine && !o.reduceMotion) {
    cursor = document.createElement('div')
    cursor.className = 'cursor'
    cursor.setAttribute('aria-hidden', 'true')
    document.body.appendChild(cursor)
    document.documentElement.classList.add('has-cursor')
    window.addEventListener('pointermove', (e) => {
      cp.tx = e.clientX
      cp.ty = e.clientY
      if (cp.x < -50) {
        cp.x = cp.tx
        cp.y = cp.ty
      }
      const t = e.target as HTMLElement
      cp.ts = t.closest('a, button') ? 2.4 : 1
    })
    document.addEventListener('pointerleave', () => cursor!.classList.add('out'))
    document.addEventListener('pointerenter', () => cursor!.classList.remove('out'))
  }

  let active = -1
  const shown = new Set<number>()
  let lastT = 0

  function measure() {
    // altezza reale dei pannelli: serve al CSS per centrarli verticalmente
    document.querySelectorAll<HTMLElement>('.panel .copy').forEach((c) => c.style.setProperty('--h', c.offsetHeight + 'px'))
  }

  function update(u: number, t: number) {
    sections.forEach((s, i) => {
      const d = Math.abs(u - i)
      const vis = clamp(1.6 - d * 2.2, 0, 1)
      s.style.setProperty('--vis', String(vis))
      // isteresi: entra sopra 0.55, esce sotto 0.12
      if (vis > 0.55 && !shown.has(i)) {
        shown.add(i)
        s.classList.add('is-in')
      } else if (vis < 0.12 && shown.has(i)) {
        shown.delete(i)
        s.classList.remove('is-in')
      }
    })
    // menu chiaro nell'anticamera (inizio e fine), scuro sulle pareti chiare della sala
    document.body.classList.toggle('past-hero', u > 0.35 && u < N - 1.45)
    document.body.classList.toggle('scrolled', u > 0.12)

    const a = clamp(Math.round(u), 0, N - 1)
    if (a !== active) {
      const dir = a > active ? 1 : -1
      active = a
      swap(curEl, pad(a + 1), dir)
      swap(labelEl, labels[a], dir)
      ticks.forEach((b, i) => b.classList.toggle('on', i === a))
    }
    fill.style.transform = `scaleX(${(u / (N - 1)).toFixed(4)})`

    if (cursor) {
      const dt = Math.min(Math.max(t - lastT, 0), 0.1)
      const k = 1 - Math.exp(-dt * 18)
      cp.x += (cp.tx - cp.x) * k
      cp.y += (cp.ty - cp.y) * k
      cp.s += (cp.ts - cp.s) * (1 - Math.exp(-dt * 10))
      cursor.style.transform = `translate3d(${cp.x.toFixed(1)}px, ${cp.y.toFixed(1)}px, 0) scale(${cp.s.toFixed(3)})`
    }
    lastT = t
  }

  /** cambio di testo con la parola che esce e la nuova che entra dal basso (o dall'alto) */
  function swap(host: HTMLElement, text: string, dir: number) {
    const old = host.firstElementChild as HTMLElement | null
    if (old && old.textContent === text) return
    const el = document.createElement('span')
    el.textContent = text
    if (o.reduceMotion || !old) {
      host.replaceChildren(el)
      return
    }
    el.style.transform = `translateY(${dir * 100}%)`
    el.style.opacity = '0'
    host.appendChild(el)
    void el.offsetWidth // stato iniziale applicato prima della transizione
    el.style.transform = 'translateY(0)'
    el.style.opacity = '1'
    for (const c of [...host.children] as HTMLElement[]) {
      if (c === el) continue
      c.style.transform = `translateY(${-dir * 100}%)`
      c.style.opacity = '0'
      setTimeout(() => c.remove(), 750)
    }
  }

  return { update, measure }
}
