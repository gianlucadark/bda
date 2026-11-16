/** Schermata di caricamento: anello di avanzamento, contatore morbido, uscita a sipario. */

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** tempo minimo di permanenza: l'animazione d'ingresso non va troncata */
const MIN_VISIBLE_MS = 1600

export function createLoader(root: HTMLElement, reduceMotion: boolean) {
  const arc = root.querySelector<SVGCircleElement>('.loader-arc')!
  const pct = root.querySelector<HTMLElement>('.loader-pct')!
  const born = performance.now()
  let target = 0
  let shown = 0
  let raf = 0

  // si mostra solo quando i caratteri sono pronti (niente cambio di font a vista)
  Promise.race([document.fonts?.ready ?? Promise.resolve(), wait(900)]).then(() => root.classList.add('in'))

  function paint() {
    arc.style.strokeDashoffset = String(1 - shown)
    pct.textContent = String(Math.round(shown * 100)).padStart(3, '0')
  }

  function loop() {
    // il contatore insegue il valore reale: avanza sempre con continuita'
    shown += (target - shown) * (reduceMotion ? 1 : 0.07)
    if (Math.abs(target - shown) < 0.002) shown = target
    paint()
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)

  return {
    /** 0..1, mai all'indietro */
    progress(p: number) {
      target = Math.max(target, Math.min(Math.max(p, 0), 1))
    },
    /** porta il contatore a 100, poi apre il sipario. Risolve quando il sipario inizia ad alzarsi. */
    async finish() {
      target = 1
      await new Promise<void>((res) => {
        const check = () => (shown >= 1 && performance.now() - born >= MIN_VISIBLE_MS ? res() : requestAnimationFrame(check))
        check()
      })
      await wait(reduceMotion ? 0 : 250)
      root.classList.add('done')
      setTimeout(() => cancelAnimationFrame(raf), 1800)
    },
    /** errore o WebGL assente: via subito */
    fail() {
      cancelAnimationFrame(raf)
      root.classList.add('done')
    },
  }
}
