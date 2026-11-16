"""Bake della galleria BDA per il web.

Fasi (tutte in Blender 5.0, Cycles CPU):
  prep   converte ogni oggetto visibile in mesh, lo assegna a un gruppo di bake,
         crea la UV "bake" (lightmap) per gruppo e salva tools/out/prep.blend
  bake   per ogni gruppo: bake COMBINED in un'immagine float condivisa, salvata
         in tools/out/raw/<gruppo>.exr (i gruppi "gloss" escludono il glossy,
         che il browser ricalcola dal vivo con una env map HDR)

  blender -b <BDA_Galleria.blend> --python tools/bake_web.py -- prep
  blender -b tools/out/prep.blend --python tools/bake_web.py -- bake --groups all --samples 96

Gli oggetti NON vengono uniti prima del bake: i materiali procedurali usano le
coordinate Object/Generated, che cambierebbero con l'unione.
"""
import bpy, bmesh, math, os, sys, time, json, argparse
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
RAW = os.path.join(OUT, "raw")
os.makedirs(RAW, exist_ok=True)

# gruppo -> risoluzione dell'atlante
GROUPS = {
    "wall_curve": 4096,   # parete curva + pozzo luce + controsoffitto
    "floor": 4096,
    "walls": 4096,        # pareti laterali, nicchia, panca
    "front": 4096,        # fronte con portale + anticamera
    "emit": 256,          # diffusore lucernario + bagliore esterno
    "name": 2048,         # lettering champagne
    "mono": 1024,         # monogramma (alpha dalla maschera originale)
    "pedestals": 2048,    # fusti, zoccoli, fili, didascalie
    "ped_tops": 2048,     # piani dei piedistalli (visti in macro)
    "crea_matte": 4096,   # dolci: parti opache + metalli
    "crea_gloss": 4096,   # dolci e piatti lucidi (glossy live)
    "awards": 4096,       # nicchia dei riconoscimenti
    "cafe_matte": 1024,
    "cafe_gloss": 2048,
    "signage": 1024,
    "fixtures": 512,
}
GLOSS_GROUPS = {"crea_gloss", "cafe_gloss"}


def group_of(o):
    n = o.name
    coll = o.users_collection[0].name if o.users_collection else ""
    if n.startswith(("Parete_Curva", "Pozzo_Fascia", "Controsoffitto")):
        return "wall_curve"
    if n.startswith(("Pavimento", "Soglia_Portale")):
        return "floor"
    if n.startswith(("Parete_Sinistra", "Parete_Destra", "Nicchia_Davanzale", "Panca_")):
        return "walls"
    if n.startswith(("Parete_Fronte", "Anticamera_")):
        return "front"
    if n.startswith(("Pozzo_Diffusore", "Esterno_Giardino")):
        return "emit"
    if n.startswith("Firma_Monogramma"):
        return "mono"
    if n.startswith("Firma_"):
        return "name"
    if n.startswith("Segnaletica"):
        return "signage"
    if n.startswith("Corpo_"):
        return "fixtures"
    if coll == "04_Riconoscimenti":
        return "awards"
    if n.startswith("Ped_") and n.endswith("_Piano"):
        return "ped_tops"
    if n.startswith(("Ped_", "Didascalia_", "Disco_Cupola")):
        return "pedestals"
    if coll in ("03_Creazioni", "07_Caffetteria"):
        base = "crea" if coll == "03_Creazioni" else "cafe"
        return base + ("_gloss" if is_glossy(o) else "_matte")
    return None


def principled(mat):
    if not mat or not mat.node_tree:
        return None
    for nd in mat.node_tree.nodes:
        if nd.type == 'BSDF_PRINCIPLED':
            return nd
    return None


def mat_params(mat):
    """roughness/metallic/coat rappresentativi (per lo specular live nel browser)."""
    p = principled(mat)
    if p is None:
        return dict(rough=0.5, metal=0.0, coat=0.0, trans=0.0)
    def val(k, d):
        i = p.inputs.get(k)
        if i is None:
            return d
        if i.is_linked:
            return d
        return float(i.default_value)
    return dict(rough=val("Roughness", 0.3), metal=val("Metallic", 0.0), coat=val("Coat Weight", 0.0),
                trans=val("Transmission Weight", 0.0))


def is_glossy(o):
    for s in o.material_slots:
        m = s.material
        if not m:
            continue
        pr = mat_params(m)
        if pr["metal"] > 0.5:
            continue
        p = principled(m)
        linked = p is not None and p.inputs["Roughness"].is_linked
        if linked or pr["rough"] <= 0.40 or pr["trans"] > 0.5:
            return True
    return False


# ------------------------------------------------------------------ PREP
# volume d'aria della galleria (coordinate Blender), da build_scene.py
H, R_WALL, R_SLOT, X_SIDE, WELL, PX, PW, P_SPRING = 3.80, 7.00, 6.30, 3.60, 0.95, 0.55, 1.40, 2.55


def in_air(p):
    x, y, z = p
    r = math.hypot(x, y)
    if y > 0 and abs(x) < X_SIDE and r < R_WALL and 0 < z < H:
        return True                                   # sala
    if R_SLOT - 0.08 < r < R_WALL and H - 0.01 <= z < H + WELL and abs(x) < X_SIDE:
        return True                                   # pozzo luce
    if -X_SIDE - 0.16 < x <= -X_SIDE and 1.30 < y < 4.70 and 0.80 < z < 2.78:
        return True                                   # nicchia
    if X_SIDE <= x < X_SIDE + 0.30 and 5.02 < y < 5.24 and 0 < z < 3.35:
        return True                                   # feritoia
    if PX - 1.35 < x < PX + 1.35 and -4.6 < y < -0.32 and 0 < z < 2.95:
        return True                                   # anticamera
    if PX - PW / 2 < x < PX + PW / 2 and -0.32 <= y <= 0 and 0 < z < P_SPRING + PW / 2:
        return True                                   # portale
    return False


def cull_hidden(o):
    """Elimina le facce che non si vedono mai (retro dei muri, sotto del pavimento):
    la risoluzione del lightmap va tutta alle superfici visibili. Le facce interne
    restano e continuano a bloccare la luce, quindi l'illuminazione non cambia."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    mw = o.matrix_world
    nmat = mw.to_3x3().inverted().transposed()
    dead = []
    for f in bm.faces:
        c = mw @ f.calc_center_median()
        n = (nmat @ f.normal).normalized()
        if not in_air(c + n * 0.03):
            # facce ampie: provo anche alcuni vertici prima di scartarle
            if not any(in_air((mw @ v.co).lerp(c, 0.1) + n * 0.03) for v in f.verts):
                dead.append(f)
    nb = len(bm.faces)
    bmesh.ops.delete(bm, geom=dead, context='FACES')
    bm.to_mesh(o.data)
    bm.free()
    print("CULL", o.name, nb, "->", len(o.data.polygons))

def prep():
    sc = bpy.context.scene
    assert sc.name == "BDA_Galleria", sc.name
    for s in list(bpy.data.scenes):
        if s != sc:
            bpy.data.scenes.remove(s)
    dg = bpy.context.evaluated_depsgraph_get()
    vis_attrs = ("visible_camera", "visible_diffuse", "visible_glossy", "visible_transmission",
                 "visible_volume_scatter", "visible_shadow")
    converted = []
    for o in list(sc.objects):
        if o.type not in ('MESH', 'CURVE', 'FONT') or o.hide_render:
            continue
        g = group_of(o)
        if g is None:
            print("SKIP", o.name)
            continue
        oe = o.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(oe, preserve_all_data_layers=True, depsgraph=dg)
        me.name = "M_" + o.name
        no = bpy.data.objects.new(o.name + "__b", me)
        no.matrix_world = o.matrix_world.copy()
        for a in vis_attrs:
            setattr(no, a, getattr(o, a))
        # materiali a livello oggetto -> sul mesh
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
        converted.append(no)
    print("converted", len(converted))
    for o in converted:
        if o["bake_group"] in ("floor", "wall_curve", "walls", "front"):
            cull_hidden(o)
        elif o["bake_group"] in ("pedestals", "ped_tops", "crea_matte", "crea_gloss", "cafe_matte", "cafe_gloss"):
            cull_contacts(o)
    # UV "bake" per gruppo (smart project multi-oggetto + pack comune)
    vl = bpy.context.view_layer
    for g, res in GROUPS.items():
        objs = [o for o in converted if o["bake_group"] == g]
        if not objs:
            print("EMPTY GROUP", g)
            continue
        for o in objs:
            me = o.data
            render_uv = None
            for uv in me.uv_layers:
                if uv.active_render:
                    render_uv = uv.name
            uv = me.uv_layers.new(name="bake")
            me.uv_layers.active = uv
            if render_uv:
                me.uv_layers[render_uv].active_render = True
            else:
                uv.active_render = True
        # la UV deve rispettare la scala reale: scala applicata temporaneamente al mesh
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
        margin = 6.0 / res
        t = time.time()
        bpy.ops.uv.smart_project(angle_limit=math.radians(60), margin_method='FRACTION', island_margin=margin,
                                 area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
        bpy.ops.uv.average_islands_scale()
        arch = g in ("floor", "wall_curve", "walls", "front", "emit")
        bpy.ops.uv.pack_islands(rotate=True, scale=True, margin_method='FRACTION', margin=margin,
                                shape_method='CONCAVE' if arch else 'CONVEX')
        bpy.ops.object.mode_set(mode='OBJECT')
        for o, s in saved:
            o.data.transform(Matrix.Diagonal((1 / s.x, 1 / s.y, 1 / s.z, 1)))
            o.scale = s
        print("UV", g, len(objs), "obj", round(time.time() - t, 1), "s")
    reuv(["pedestals"])   # fusti: UV cilindrica con cucitura sul retro
    fix_mono_uv()
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "prep.blend"), compress=True)
    print("PREP SAVED")


def cylinder_uv(o):
    """UV cilindrica per i fusti dei piedistalli: un'unica isola, cucitura sul retro (+Y,
    verso la parete), cosi' nessun bordo d'isola cade sul lato visibile."""
    me = o.data
    mw = o.matrix_world
    cx, cy = mw.translation.x, mw.translation.y
    uvl = me.uv_layers["bake"]
    xs = [(mw @ v.co) for v in me.vertices]
    r = max(math.hypot(p.x - cx, p.y - cy) for p in xs)
    circ = 2 * math.pi * r
    for poly in me.polygons:
        us = []
        for li in poly.loop_indices:
            p = xs[me.loops[li].vertex_index]
            a = math.atan2(-(p.x - cx), -(p.y - cy))      # 0 = davanti (-Y), +-pi = retro
            us.append(((a + math.pi) / (2 * math.pi) * circ, p.z))
        umin, umax = min(u for u, _ in us), max(u for u, _ in us)
        if umax - umin > circ / 2:
            us = [(u + circ if u < circ / 2 else u, z) for u, z in us]
        for li, (u, z) in zip(poly.loop_indices, us):
            uvl.data[li].uv = (u, z)


def reuv(groups):
    """Rifa la UV "bake" solo per i gruppi indicati (prep.blend gia' pronto)."""
    vl = bpy.context.view_layer
    for g in groups:
        res = GROUPS[g]
        objs = [o for o in bpy.context.scene.objects if o.get("bake_group") == g]
        cyl = [o for o in objs if o.name.startswith("Ped_") and o.name.endswith("_Fusto")]
        for o in cyl:
            cylinder_uv(o)
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.select_set(True)
            sel = o not in cyl
            for v in o.data.vertices:
                v.select = sel
            for e in o.data.edges:
                e.select = sel
            for poly in o.data.polygons:
                poly.select = sel
        vl.objects.active = objs[0]
        margin = 12.0 / res
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(60), margin_method='FRACTION', island_margin=margin,
                                 area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.select_all(action='SELECT')
        bpy.ops.uv.average_islands_scale()
        bpy.ops.uv.pack_islands(rotate=True, scale=True, margin_method='FRACTION', margin=margin, shape_method='CONVEX')
        bpy.ops.object.mode_set(mode='OBJECT')
        print("REUV", g, len(objs), "cyl", len(cyl))


def fix_mono_uv():
    """Monogramma: la UV di bake coincide con quella della maschera, cosi' nel browser
    la maschera originale fa da alpha sullo stesso spazio UV."""
    for o in bpy.data.objects:
        if o.get("bake_group") == "mono":
            me = o.data
            src = [uv for uv in me.uv_layers if uv.name != "bake"][0]
            dst = me.uv_layers["bake"]
            for a, b in zip(src.data, dst.data):
                b.uv = a.uv
            print("MONO UV copied from", src.name)



def cull_contacts(o):
    """Facce appoggiate (fondi di piatti, dolci, piedistalli) e tappi interni dei piedistalli:
    coperte da altre superfici, non si vedono mai."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    mw = o.matrix_world
    nmat = mw.to_3x3().inverted().transposed()
    zs = [(mw @ v.co).z for v in bm.verts]
    if not zs:
        bm.free(); return
    zmin, zmax = min(zs), max(zs)
    stacked = o.name.startswith("Ped_") and o.name.split("_")[-1] in ("Fusto", "Filo", "Zoccolo")
    dead = []
    for f in bm.faces:
        n = (nmat @ f.normal).normalized()
        cz = (mw @ f.calc_center_median()).z
        if n.z < -0.97 and cz < zmin + 0.002:
            dead.append(f)
        elif stacked and n.z > 0.97 and cz > zmax - 0.002:
            dead.append(f)
    if dead:
        nb = len(bm.faces)
        bmesh.ops.delete(bm, geom=dead, context='FACES')
        bm.to_mesh(o.data)
        print("CULLC", o.name, nb, "->", nb - len(dead))
    bm.free()


# ------------------------------------------------------------------ BAKE
SAMPLES = {"wall_curve": 40, "floor": 160, "walls": 40, "front": 40, "awards": 48,
           "crea_matte": 96, "crea_gloss": 96, "emit": 16, "fixtures": 32}
def setup_cycles(sc, samples):
    sc.render.engine = 'CYCLES'
    cy = sc.cycles
    cy.device = 'CPU'
    cy.samples = samples
    cy.use_adaptive_sampling = False
    cy.use_denoising = False
    cy.max_bounces = 6
    cy.diffuse_bounces = 3
    cy.glossy_bounces = 3
    cy.transmission_bounces = 6
    cy.sample_clamp_indirect = 4
    cy.use_auto_tile = False


def bake_group(g, samples):
    sc = bpy.context.scene
    objs = [o for o in sc.objects if o.get("bake_group") == g]
    if not objs:
        return
    res = GROUPS[g]
    name = "BAKE_" + g
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, res, res, alpha=False, float_buffer=True)
    img.colorspace_settings.name = 'Linear Rec.709'
    mats = set()
    for o in objs:
        for s in o.material_slots:
            if s.material:
                mats.add(s.material)
    added = []
    for m in mats:
        nt = m.node_tree
        for nd in nt.nodes:
            nd.select = False
        n = nt.nodes.new('ShaderNodeTexImage')
        n.name = "BAKE_TARGET"
        n.image = img
        n.select = True
        nt.nodes.active = n
        added.append((m, n))
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    passes = {'DIRECT', 'INDIRECT', 'DIFFUSE', 'GLOSSY', 'TRANSMISSION', 'EMIT'}
    if g in GLOSS_GROUPS:
        passes.discard('GLOSSY')
    sc.render.bake.margin = 12
    sc.render.bake.margin_type = 'ADJACENT_FACES'
    sc.render.bake.use_clear = True
    t = time.time()
    bpy.ops.object.bake(type='COMBINED', pass_filter=passes, margin=16, margin_type='ADJACENT_FACES', use_clear=True,
                        target='IMAGE_TEXTURES')
    dt = time.time() - t
    path = os.path.join(RAW, g + ".exr")
    img.filepath_raw = path
    img.file_format = 'OPEN_EXR'
    sc.render.image_settings.file_format = 'OPEN_EXR'
    sc.render.image_settings.color_depth = '16'
    sc.render.image_settings.exr_codec = 'ZIP'
    img.save_render(path, scene=sc) if False else img.save(filepath=path)
    for m, n in added:
        m.node_tree.nodes.remove(n)
    print("BAKED", g, res, "samples", samples, "in", round(dt, 1), "s ->", path, flush=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("phase")
    ap.add_argument("--groups", default="all")
    ap.add_argument("--samples", type=int, default=0)  # 0 = tabella SAMPLES (64 se assente)
    ap.add_argument("--gloss-samples", type=int, default=0)
    a = ap.parse_args(argv)
    if a.phase == "prep":
        prep()
    elif a.phase == "reuv":
        reuv(a.groups.split(","))
        bpy.ops.wm.save_mainfile(compress=True)
    elif a.phase == "fixmono":
        fix_mono_uv()
        bpy.ops.wm.save_mainfile(compress=True)
    elif a.phase == "bake":
        sc = bpy.context.scene
        groups = list(GROUPS) if a.groups == "all" else a.groups.split(",")
        for g in groups:
            s = SAMPLES.get(g, 64) if a.samples == 0 else a.samples
            setup_cycles(sc, s)
            bake_group(g, s)
        print("ALL DONE")


main()
