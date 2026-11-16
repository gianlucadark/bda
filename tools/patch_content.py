"""Aggiorna i contenuti della galleria senza ricostruirla:
- didascalie dei piedistalli: categorie generiche al posto dei nomi dei singoli dolci
- nicchia: disegno segnaposto al posto della foto reale, con didascalia "immagine provvisoria"

Funziona su due tipi di file:
  sorgente  (BDA_Galleria.blend: i testi sono ancora curve FONT -> si cambia il testo)
  prep.blend (testi gia' convertiti in mesh -> si ricreano nella stessa posizione e si rifa la UV)

  blender -b <file.blend> --python tools/patch_content.py
"""
import bpy, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEMO = os.path.join(os.path.dirname(HERE), "..", "BDA_Galleria_Demo")
sys.path.insert(0, os.path.join(DEMO, "scripts"))
import lib  # noqa: E402  (helper testi/font della scena originale)

PLACEHOLDER = os.path.abspath(os.path.join(DEMO, "assets", "textures", "segnaposto_disegno.png"))

CAPTIONS = {
    "01": ("Monoporzioni", "IN FORMATO INDIVIDUALE"),
    "02": ("Torte", "A STRATI E PER LE RICORRENZE"),
    "03": ("Piccola pasticceria", "FROLLE E PASTE DA VETRINA"),
}
PHOTO_CAPTION = "IMMAGINE PROVVISORIA"

# parametri dei testi come in build_scene.py: font, corpo, allineamento, spaziatura
STYLE = {
    "T": ("CormorantGaramond-Italic.ttf", 0.0135, 'LEFT', 1.0),
    "S": ("Jost-Book.ttf", 0.0058, 'LEFT', 1.15),
    "PHOTO": ("Jost-Book.ttf", 0.0105, 'CENTER', 1.3),
}


def new_text_mesh(old, body, style):
    """Ricrea un testo convertito in mesh con lo stesso riferimento (origine = ancora del testo)."""
    fname, size, align, track = style
    lib.COLL = old.users_collection[0]
    mat = old.data.materials[0] if old.data.materials else None
    ob = lib.text(old.name + "__new", body, fname, size, (0, 0, 0), (0, 0, 0), mat, align=align,
                  tracking=track, to_mesh=True)
    ob.matrix_world = old.matrix_world.copy()
    for k in old.keys():
        ob[k] = old[k]
    name = old.name
    bpy.data.objects.remove(old, do_unlink=True)
    ob.name = name
    return ob


def swap_photo():
    mat = bpy.data.materials.get("Foto_Targa")
    img = bpy.data.images.load(PLACEHOLDER, check_existing=True)
    img.pack()
    for nd in mat.node_tree.nodes:
        if nd.type == 'TEX_IMAGE' and nd.name != "BAKE_TARGET":
            old = nd.image
            nd.image = img
            if old and old != img and old.users == 0:
                bpy.data.images.remove(old)
    print("PHOTO ->", os.path.basename(PLACEHOLDER))


def main():
    objs = bpy.data.objects
    is_prep = any(o.get("bake_group") for o in objs)
    for n, (title, sub) in CAPTIONS.items():
        for suffix, body in (("T", title), ("S", sub)):
            o = objs.get("Didascalia_%s_%s" % (n, suffix))
            if o is None:
                print("MISSING", n, suffix)
                continue
            if o.type == 'FONT':
                o.data.body = body.replace("·", "/") if suffix == "S" else body
            else:
                new_text_mesh(o, body.replace("·", "/") if suffix == "S" else body, STYLE[suffix])
            print("CAPTION", n, suffix, body)
    o = objs.get("Foto_Targa_Fondi_2025_txt")
    if o is not None:
        if o.type == 'FONT':
            o.data.body = PHOTO_CAPTION
        else:
            new_text_mesh(o, PHOTO_CAPTION, STYLE["PHOTO"])
        print("CAPTION photo")
    swap_photo()
    if is_prep:
        src = open(os.path.join(HERE, "bake_web.py"), encoding="utf-8").read().replace("\nmain()\n", "\n")
        ns = {"__file__": os.path.join(HERE, "bake_web.py"), "__name__": "bake_web"}
        exec(compile(src, "bake_web.py", "exec"), ns)
        ns["reuv"](["pedestals", "awards"])
    bpy.ops.wm.save_mainfile(compress=True)
    print("PATCHED", bpy.data.filepath, "prep" if is_prep else "sorgente")


main()
