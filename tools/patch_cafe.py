"""Angolo caffetteria: alzatina con pasticcini mignon e stuzzichini dell'aperitivo accanto al vassoio,
piu' la nuova inquadratura Cam_04d_Caffe. Non ricostruisce la galleria.

Funziona su due tipi di file (come patch_content.py):
  sorgente   BDA_Galleria.blend -> aggiunge gli oggetti nella collezione 07_Caffetteria
  prep.blend gli oggetti vengono anche convertiti in mesh, assegnati ai gruppi cafe_* e la UV di bake
             dei due gruppi del caffe' viene rifatta (gli altri gruppi restano identici)

  blender -b <file.blend> --python tools/patch_cafe.py -- --save
  blender -b <file.blend> --python tools/patch_cafe.py -- --preview out.png [--pct 50 --samples 24]

Idempotente: gli oggetti di una patch precedente vengono rimossi prima di ricrearli.
"""
import bpy, os, sys, math, time, argparse
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
DEMO = os.path.abspath(os.path.join(HERE, "..", "..", "BDA_Galleria_Demo"))
sys.path.insert(0, os.path.join(DEMO, "scripts"))
import lib, materials, desserts  # noqa: E402

# posizioni nel riferimento del vassoio (x lungo la panca verso il bicchiere, y verso la parete)
STAND = (-0.215, 0.052)
SNACKS = (0.212, -0.018)
CANNOLO = (0.083, -0.064, 0.012, 0.16)   # x, y, z (piano del vassoio), rotazione
# camera: in basso a sinistra rispetto al vassoio, l'alzatina in primo piano
CAM = dict(pos=(-0.38, -0.41, 0.33), target=(-0.075, 0.08, 0.03), lens=50.0, fstop=4.0,
           focus_at=(-0.215, 0.052, 0.068))
NEW_PREFIX = ("Alzatina_", "Mignon_", "Aperitivo_Ciotola", "Aperitivo_Oliva", "Aperitivo_Tarallo",
              "Aperitivo_Stuzzichini")


def tray_frame():
    t = bpy.data.objects.get("Angolo_Caffe_Aperitivo")
    if t is not None:
        return t.matrix_world.copy()
    rb = 6.71
    a = math.asin(-1.40 / rb)
    return Matrix.Translation((rb * math.sin(a), rb * math.cos(a), 0.44)) @ Matrix.Rotation(-a, 4, 'Z')


def remove_old():
    n = 0
    for o in list(bpy.data.objects):
        if o.name.startswith(NEW_PREFIX):
            bpy.data.objects.remove(o, do_unlink=True)
            n += 1
    for me in list(bpy.data.meshes):
        if me.users == 0:
            bpy.data.meshes.remove(me)
    if n:
        print("REMOVED", n)


def build():
    before = set(bpy.data.objects)
    have = dict(porcelain="Porcellana", pistachio="Pistacchio_Granella", tart="Frolla_Tartelletta",
                choc_glaze="Glassa_Fondente", gold_leaf="Foglia_Oro")
    M = {k: bpy.data.materials[v] for k, v in have.items()}
    materials.build_cafe_extra(M)
    lib.set_collection("07_Caffetteria")
    F = tray_frame()
    rz = F.to_euler().z
    desserts.cafe_pastries(M, F @ Vector((*STAND, 0.0)), rz)
    desserts.cafe_snacks(M, F @ Vector((*SNACKS, 0.0)), rz)
    desserts.cafe_cannolo(M, F @ Vector(CANNOLO[:3]), rz + CANNOLO[3])
    new = [o for o in bpy.data.objects if o not in before]
    # camera
    cam = bpy.data.objects["Cam_04d_Caffe"]
    pos = F @ Vector(CAM["pos"])
    tgt = F @ Vector(CAM["target"])
    cam.location = pos
    cam.rotation_euler = lib.look_matrix(pos, tgt)
    cam.data.lens = CAM["lens"]
    cam.data.dof.use_dof = True
    cam.data.dof.aperture_fstop = CAM["fstop"]
    cam.data.dof.focus_object = None
    cam.data.dof.focus_distance = (F @ Vector(CAM["focus_at"]) - pos).length
    print("CAM", tuple(round(c, 3) for c in pos), "->", tuple(round(c, 3) for c in tgt),
          "focus", round(cam.data.dof.focus_distance, 3))
    print("BUILT", len(new), "objects")
    return new


def load_bake_ns():
    src = open(os.path.join(HERE, "bake_web.py"), encoding="utf-8").read().replace("\nmain()\n", "\n")
    ns = {"__file__": os.path.join(HERE, "bake_web.py"), "__name__": "bake_web"}
    exec(compile(src, "bake_web.py", "exec"), ns)
    return ns


def to_prep(new):
    """Come bake_web.prep() per i soli oggetti nuovi, poi UV di bake dei gruppi cafe_*."""
    ns = load_bake_ns()
    dg = bpy.context.evaluated_depsgraph_get()
    vis_attrs = ("visible_camera", "visible_diffuse", "visible_glossy", "visible_transmission",
                 "visible_volume_scatter", "visible_shadow")
    conv = []
    for o in new:
        if o.type not in ('MESH', 'CURVE', 'FONT'):
            continue
        g = ns["group_of"](o)
        assert g in ("cafe_matte", "cafe_gloss"), (o.name, g)
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        me.name = "M_" + o.name
        no = bpy.data.objects.new(o.name + "__b", me)
        no.matrix_world = o.matrix_world.copy()
        for a in vis_attrs:
            setattr(no, a, getattr(o, a))
        for i, s in enumerate(o.material_slots):
            if i < len(me.materials):
                me.materials[i] = s.material
            else:
                me.materials.append(s.material)
        for c in o.users_collection:
            c.objects.link(no)
        no["bake_group"] = g
        nm = o.name
        bpy.data.objects.remove(o)
        no.name = nm
        conv.append(no)
    for o in conv:
        ns["cull_contacts"](o)
    print("CONVERTED", len(conv), {g: sum(1 for o in conv if o["bake_group"] == g) for g in ("cafe_matte", "cafe_gloss")})
    vl = bpy.context.view_layer
    for g in ("cafe_matte", "cafe_gloss"):
        res = ns["GROUPS"][g]
        objs = [o for o in bpy.context.scene.objects if o.get("bake_group") == g]
        for o in objs:
            me = o.data
            uv = me.uv_layers.get("bake") or me.uv_layers.new(name="bake")
            me.uv_layers.active = uv
            if not any(u.active_render for u in me.uv_layers):
                uv.active_render = True
        saved = []
        for o in objs:
            s = o.scale.copy()
            if any(abs(c - 1) > 1e-4 for c in s):
                o.data.transform(Matrix.Diagonal((s.x, s.y, s.z, 1)))
                saved.append((o, s))
                o.scale = (1, 1, 1)
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.select_set(True)
        vl.objects.active = objs[0]
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        margin = 8.0 / res
        t = time.time()
        bpy.ops.uv.smart_project(angle_limit=math.radians(60), margin_method='FRACTION', island_margin=margin,
                                 area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
        bpy.ops.uv.average_islands_scale()
        bpy.ops.uv.pack_islands(rotate=True, scale=True, margin_method='FRACTION', margin=margin, shape_method='CONVEX')
        bpy.ops.object.mode_set(mode='OBJECT')
        for o, s in saved:
            o.data.transform(Matrix.Diagonal((1 / s.x, 1 / s.y, 1 / s.z, 1)))
            o.scale = s
        print("UV", g, len(objs), "obj", round(time.time() - t, 1), "s")


def preview(out, pct, samples):
    sc = bpy.data.scenes["BDA_Galleria"]
    sc.camera = bpy.data.objects["Cam_04d_Caffe"]
    sc.render.engine = 'CYCLES'
    cy = sc.cycles
    cy.device = 'CPU'; cy.samples = samples
    cy.use_adaptive_sampling = True; cy.adaptive_threshold = 0.03
    cy.use_denoising = True; cy.denoiser = 'OPENIMAGEDENOISE'
    cy.max_bounces = 6; cy.diffuse_bounces = 3; cy.glossy_bounces = 3; cy.transmission_bounces = 4
    cy.sample_clamp_indirect = 4
    sc.render.resolution_percentage = pct
    sc.render.image_settings.file_format = 'PNG'
    sc.render.filepath = out
    t = time.time()
    bpy.ops.render.render(write_still=True, scene=sc.name)
    print("RENDERED %.1fs -> %s" % (time.time() - t, out))


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--save", action="store_true")
    ap.add_argument("--preview", default="")
    ap.add_argument("--pct", type=int, default=50)
    ap.add_argument("--samples", type=int, default=24)
    a = ap.parse_args(argv)
    is_prep = any(o.get("bake_group") for o in bpy.data.objects)
    remove_old()
    new = build()
    if a.preview:
        preview(a.preview, a.pct, a.samples)
    if a.save:
        if is_prep:
            to_prep(new)
        bpy.ops.wm.save_mainfile(compress=True)
        print("PATCHED", bpy.data.filepath, "prep" if is_prep else "sorgente")


main()
