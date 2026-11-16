import re
p='tools/bake_web.py'; s=open(p,encoding='utf-8').read()
s=s.replace('''    print("converted", len(converted))
''','''    print("converted", len(converted))
    for o in converted:
        if o["bake_group"] in ("floor", "wall_curve", "walls", "front"):
            cull_hidden(o)
''')
s=s.replace('''        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.select_set(True)
        vl.objects.active = objs[0]
        bpy.ops.object.mode_set(mode='EDIT')''','''        # la UV deve rispettare la scala reale: scala applicata temporaneamente al mesh
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
        bpy.ops.object.mode_set(mode='EDIT')''')
s=s.replace('''        bpy.ops.uv.pack_islands(rotate=True, scale=True, margin_method='FRACTION', margin=margin,
                                shape_method='AABB' if len(objs) > 20 or g in ("name", "awards", "signage") else 'CONCAVE')
        bpy.ops.object.mode_set(mode='OBJECT')''','''        arch = g in ("floor", "wall_curve", "walls", "front", "emit")
        bpy.ops.uv.pack_islands(rotate=True, scale=True, margin_method='FRACTION', margin=margin,
                                shape_method='CONCAVE' if arch else 'CONVEX')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.select_all(action='DESELECT')
        bpy.ops.uv.select_overlap()
        n_ov = sum(1 for o in objs for p in o.data.polygons if p.select) if False else None
        bpy.ops.object.mode_set(mode='OBJECT')
        n_ov = 0
        for o in objs:
            uvd = o.data.uv_layers["bake"]
            n_ov += sum(1 for v in uvd.vertex_selection if v.value) if hasattr(uvd, "vertex_selection") else 0
        for o, s in saved:
            o.data.transform(Matrix.Diagonal((1 / s.x, 1 / s.y, 1 / s.z, 1)))
            o.scale = s
        print("UV overlap loops", g, n_ov)''')
s=s.replace("import bpy, math, os, sys, time, json, argparse","import bpy, bmesh, math, os, sys, time, json, argparse\nfrom mathutils import Matrix, Vector")
s=s.replace('''# ------------------------------------------------------------------ PREP''','''# ------------------------------------------------------------------ PREP
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
''')
open(p,'w',encoding='utf-8').write(s)
