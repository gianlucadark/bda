# Landing — Bruno D'Angelis Pasticcere, Fondi

Landing page con la galleria 3D di `../BDA_Galleria_Demo`, navigabile con lo scroll.
La qualità viene da Cycles: luce, ombre morbide, rimbalzi e materiali procedurali sono **cotti** in texture, e il browser li mostra senza ricalcolarli.

## Avvio

```bash
npm install
```
```bash
npm run dev
```
```bash
npm run build
```

Il dev server parte su http://localhost:5180. La build statica va in `dist/` e si pubblica su qualunque hosting statico. Conviene servire `.glb`, `.hdr` e `.webp` con compressione e cache lunga.

## Come funziona il 3D

| Livello | Dove | Cosa fa |
|---|---|---|
| Bake | `tools/bake_web.py` | Converte la scena in mesh e la divide in 16 gruppi. Per ogni gruppo crea una UV di lightmap e fa un bake Cycles `COMBINED` (luce diretta e indiretta, materiali). Le facce mai visibili vengono eliminate prima, così tutta la risoluzione va alle superfici che si vedono. |
| Post | `tools/post_web.py` | Denoise OpenImageDenoise sul bake HDR, poi tonemapping **AgX Medium High Contrast +0.3 EV**, lo stesso dei render. Produce WebP a piena risoluzione e `_m` a metà, per il mobile. |
| Sonda | `tools/probe_web.py` | Panorama HDR 360° renderizzato con Cycles davanti ai piedistalli (`public/scene/env.hdr`). |
| Export | `tools/export_web.py` | Unisce ogni gruppo in una sola mesh, esporta il GLB e scrive `manifest.json` con gruppi, camere Blender e faretti. Il GLB viene poi compresso con meshopt. |
| Runtime | `src/scene.ts` | Le superfici opache usano `MeshBasicMaterial`: il texel è già il colore finale. Glasse, cioccolato, porcellana e tazzina hanno il bake **senza glossy**, mentre i riflessi sono calcolati dal vivo dalla sonda HDR (PBR con rugosità del materiale Blender) e si muovono con la camera. La coppa dell'aperitivo usa trasmissione reale: il vetro non si può cuocere. |
| Post | `src/post.ts` | Catena in HDR lineare: scena in MSAA con depth, autofocus, profondità di campo, bloom, aberrazione cromatica appena accennata, grana di pellicola e uscita sRGB. |
| DOF | `src/post.ts` | Cerchio di confusione per pixel dalla formula della lente sottile (focale, f-stop e `focus_distance` delle camere Blender). Lo sfocato è un gather a disco a metà risoluzione che separa campo vicino e lontano, quindi niente aloni nitidi attorno ai dolci e primo piano che sfuma sopra lo sfondo. Una fascia di nitidezza proporzionale alla distanza tiene a fuoco tutto il dolce, dal bordo davanti a quello dietro. Si attiva solo dove lo sfocato supera mezzo pixel. |
| Autofocus | `src/post.ts` | La distanza di fuoco vive in un pixel 1×1 sulla GPU. Sulle stazioni vale quella di Blender, nei tragitti è misurata sul depth buffer lungo l'asse ottico e inseguita in diottrie, come un fuoco a motore. |
| Aria | `src/atmosphere.ts` | Coni dei faretti appena percepibili, pulviscolo che brilla solo dentro la luce, vapore dell'espresso. Tutto additivo o trasparente, senza scrivere nel depth buffer. |
| Interfaccia | `src/ui.ts` | Titoli rivelati parola per parola, contatore dei capitoli cliccabile con barra di avanzamento, invito a scorrere, cursore ad anello sui puntatori fini. |
| Camera | `src/camera-path.ts` | Le stazioni sono le camere progettate in Blender, con le stesse ottiche e lo stesso shift verticale. I punti intermedi evitano pareti e piedistalli, e lo scroll si ferma morbidamente su ogni stazione. |

Accorgimenti di bake: le facce mai visibili (retro dei muri, fondi appoggiati, tappi interni) vengono eliminate prima delle UV. I fusti dei piedistalli hanno una UV cilindrica con la cucitura verso la parete. Il margine è `ADJACENT_FACES`: oltre la cucitura continua la superficie vera, quindi nei mipmap non compaiono righe. Il GLB è compresso con meshopt `high`: 3,6 MB.

Peso scaricato: circa 12 MB su desktop (atlanti 4K, compresi i due del caffè) e circa 7 MB su mobile (atlanti a metà risoluzione).

Il renderer non applica tone mapping (`NoToneMapping`): è già contenuto nelle texture, quindi i colori corrispondono ai render Cycles.

### Rifare il bake

Richiede circa 2,5–3 ore su CPU con Blender 5.0 (i dolci a 96 campioni e il pavimento a 160 sono i gruppi più lenti). Tutto si rigenera da script:

```bash
./tools/run_all.sh
```

Per rifare solo alcuni gruppi:

```bash
"C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b tools/out/prep.blend --python tools/bake_web.py -- bake --groups crea_gloss,crea_matte
```
```bash
"C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup --python tools/post_web.py -- --groups crea_gloss,crea_matte
```

I campioni per gruppo sono in `SAMPLES` (`tools/bake_web.py`): 40 per l'architettura, 96 per i dolci e 64 di default. Il denoise fa il resto. I raw HDR restano in `tools/out/raw/*.exr`, quindi si può cambiare tonemapping o denoise senza ricuocere.

### Angolo caffetteria

Accanto al vassoio c'è un'alzatina in porcellana con sei pasticcini mignon nei pirottini champagne: bignè al caffè, bignè al cioccolato con foglia d'oro, babà, pasta di mandorla con ciliegina candita, crostatina con crema, lampone e mirtilli, macaron al pistacchio e al lampone. Sul vassoio c'è un cannolo, a destra una ciotolina di olive per l'aperitivo. La geometria è in `../BDA_Galleria_Demo/scripts/desserts.py` (`cafe_pastries`, `cafe_snacks`, `cafe_cannolo`), i materiali in `materials.py` (`build_cafe_extra`).

`tools/patch_cafe.py` aggiunge tutto a un `.blend` esistente senza ricostruire la galleria, insieme alla nuova inquadratura `Cam_04d_Caffe`. Su `prep.blend` converte anche gli oggetti, li assegna ai gruppi `cafe_*` e rifà la UV di bake solo di quei due gruppi. `tools/run_cafe.sh` esegue la patch, poi il bake di `cafe_matte`, `cafe_gloss` e `walls` (le ombre di contatto sulla panca), il post, l'export e la compressione. Ci vuole circa un'ora.

## Debug

- `?normals` mostra la geometria con le normali, senza texture.
- `?u=3` blocca la camera su una stazione: 0 ingresso … 8 visita.
- `?nodof` spegne la profondità di campo, `?debug=coc` colora il cerchio di confusione (blu davanti, arancio dietro).
- `?noatmo` toglie coni di luce, pulviscolo e vapore.
- Solo in dev, `window.__shot(u, nome, w, h)` salva un fotogramma in `tools/out/shots/`.

## Contenuti

- Nella nicchia, al posto della foto reale, c'è un disegno segnaposto (`tools/make_placeholder.py`) con la didascalia "Immagine provvisoria". Quando il cliente fornirà una sua foto, basta sostituire `../BDA_Galleria_Demo/assets/textures/segnaposto_disegno.png`, rilanciare `tools/patch_content.py` e ricuocere il gruppo `awards`.
- Le creazioni sono presentate per categoria (monoporzioni, torte, piccola pasticceria), senza nomi di singoli dolci, sia nella pagina sia sulle didascalie in 3D.
- Da confermare: "primo posto con la squadra italiana" al Mondial des Arts Sucrés 2016 (una sola fonte, vedi `../BDA_Galleria_Demo/SOURCES.md`) e il monogramma.
