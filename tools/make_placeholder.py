"""Disegno segnaposto (al posto della foto reale): torta su alzatina sotto campana,
tratto a inchiostro seppia su carta, leggermente irregolare come un disegno a mano.

  blender -b --factory-startup --python tools/make_placeholder.py -- <out.png>
"""
import bpy, sys, os, math
import numpy as np

out = sys.argv[sys.argv.index("--") + 1]
W, H = 876, 1184                         # stesso formato della foto sostituita (438x592 x2)
y, x = np.mgrid[0:H, 0:W].astype(np.float32)
rng = np.random.default_rng(7)

# carta: avorio con fibra appena percettibile
paper = np.array([0.925, 0.898, 0.850], np.float32)
grain = rng.normal(0, 1, (H // 4 + 1, W // 4 + 1)).astype(np.float32)
grain = np.kron(grain, np.ones((4, 4), np.float32))[:H, :W]
img = np.ones((H, W, 3), np.float32) * paper
img *= (1 + 0.012 * grain)[..., None]

ink = np.array([0.30, 0.24, 0.18], np.float32)
dist = np.full((H, W), 1e9, np.float32)


def wobble(t, seed, amp=1.6):
    r = np.random.default_rng(seed)
    a, b, c = r.uniform(0, 6.28, 3)
    return amp * (np.sin(t * 7 + a) * 0.6 + np.sin(t * 17 + b) * 0.3 + np.sin(t * 31 + c) * 0.1)


def poly(pts, seed=0, n=400):
    """polilinea campionata: distanza minima dai punti (tratto con leggera irregolarita')"""
    global dist
    pts = np.array(pts, np.float32)
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    L = np.concatenate([[0], np.cumsum(seg)])
    ts = np.linspace(0, L[-1], max(n, int(L[-1] / 1.5)))
    px = np.interp(ts, L, pts[:, 0]); py = np.interp(ts, L, pts[:, 1])
    tt = ts / max(L[-1], 1)
    px = px + wobble(tt, seed); py = py + wobble(tt, seed + 1)
    for cx, cy in zip(px, py):
        x0, x1 = int(max(cx - 6, 0)), int(min(cx + 7, W)); y0, y1 = int(max(cy - 6, 0)), int(min(cy + 7, H))
        d = np.hypot(x[y0:y1, x0:x1] - cx, y[y0:y1, x0:x1] - cy)
        dist[y0:y1, x0:x1] = np.minimum(dist[y0:y1, x0:x1], d)


def arc(cx, cy, rx, ry, a0, a1, seed=0):
    a = np.linspace(a0, a1, 200)
    poly(np.stack([cx + rx * np.cos(a), cy + ry * np.sin(a)], 1), seed)


cx = W / 2
base = 900                                  # piano d'appoggio dell'alzatina
# alzatina: piede, stelo, piatto
arc(cx, base, 120, 18, 0, math.pi, 1)
poly([(cx - 120, base), (cx + 120, base)], 2)
poly([(cx - 16, base - 14), (cx - 10, base - 150)], 3)
poly([(cx + 16, base - 14), (cx + 10, base - 150)], 4)
arc(cx, base - 160, 230, 26, 0, math.pi, 5)                     # bordo anteriore del piatto
k = math.acos(150 / 230)                                          # bordo posteriore: solo fuori dalla torta
arc(cx, base - 160, 230, 26, math.pi, math.pi + k, 19)
arc(cx, base - 160, 230, 26, 2 * math.pi - k, 2 * math.pi, 20)
# torta: cilindro con due strati
top, bot = base - 330, base - 172
arc(cx, top, 150, 22, 0, 2 * math.pi, 6)
poly([(cx - 150, top), (cx - 150, bot)], 7)
poly([(cx + 150, top), (cx + 150, bot)], 8)
arc(cx, bot, 150, 22, 0, math.pi, 9)
arc(cx, top + 60, 150, 22, 0.15, math.pi - 0.15, 10)
arc(cx, top + 110, 150, 22, 0.2, math.pi - 0.2, 11)
# una ciliegia/frutto e due riccioli sul piano della torta
arc(cx + 30, top - 22, 18, 18, 0, 2 * math.pi, 12)
poly([(cx + 34, top - 40), (cx + 52, top - 78)], 13)
arc(cx - 60, top - 10, 22, 12, 3.4, 6.0, 14)
# campana di vetro: cupola + pomolo
arc(cx, base - 160, 250, 470, math.pi, 2 * math.pi, 15)
arc(cx, base - 650, 26, 22, 0, 2 * math.pi, 16)
# riflesso sul vetro (due tratti brevi)
arc(cx, base - 160, 215, 420, 3.55, 3.95, 17)

alpha = np.clip(2.2 - dist, 0, 1) ** 1.3       # tratto ~2 px con bordo morbido
alpha *= 0.85 + 0.15 * rng.random((H, W)).astype(np.float32)
img = img * (1 - alpha[..., None]) + ink * alpha[..., None]

rgba = np.ones((H, W, 4), np.float32)
rgba[..., :3] = np.flipud(img)                  # Blender: riga 0 in basso
im = bpy.data.images.new("segnaposto", W, H)
im.colorspace_settings.name = 'sRGB'
im.pixels.foreach_set(rgba.ravel())
im.filepath_raw = os.path.abspath(out)
im.file_format = 'PNG'
im.save()
print("PLACEHOLDER", out)
