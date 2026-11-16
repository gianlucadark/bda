"""Export per il web da tools/out/prep.blend (dopo il bake).

  blender -b tools/out/prep.blend --python tools/export_web.py

- unisce gli oggetti di ogni gruppo di bake in un'unica mesh (UV "bake" sola)
- materiali: uno per gruppo; nei gruppi "gloss" uno per materiale originale,
  con i parametri per lo specular live nel manifest
- GLB grezzo in tools/out/galleria_raw.glb (poi compresso con gltf-transform)
- public/scene/manifest.json: gruppi, camere, faretti (coordinate three.js, Y-up)
"""
import bpy, os, sys, json, math
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(HERE)
PUB = os.path.join(ROOT, "public", "scene")
os.makedirs(PUB, exist_ok=True)

# riuso definizioni dal modulo di bake senza eseguirne il main
src = open(os.path.join(HERE, "bake_web.py"), encoding="utf-8").read().replace("\nmain()\n", "\n")
ns = {"__file__": os.path.join(HERE, "bake_web.py"), "__name__": "bake_web"}
exec(compile(src, "bake_web.py", "exec"), ns)
GROUPS, GLOSS_GROUPS, mat_params = ns["GROUPS"], ns["GLOSS_GROUPS"], ns["mat_params"]


def b2t(v):
    """Blender Z-up -> three.js Y-up"""
    return [round(v[0], 5), round(v[2], 5), round(-v[1], 5)]


def principled_color(mat):
    p = ns["principled"](mat)
    if p is None:
        return [0.5, 0.5, 0.5]
    i = p.inputs["Base Color"]
    if i.is_linked:
        return None
    return [round(c, 4) for c in i.default_value[:3]]


def main():
    sc = bpy.context.scene
    manifest = {"groups": {}, "cameras": {}, "spots": [], "path": []}
    vl = bpy.context.view_layer
    # ---------------------------------------------------- camere e luci (prima di modificare la scena)
    for o in sc.objects:
        if o.type == 'CAMERA':
            m = o.matrix_world
            fwd = (m.to_3x3() @ Vector((0, 0, -1))).normalized()
            up = (m.to_3x3() @ Vector((0, 1, 0))).normalized()
            pos = m.translation
            d = o.data
            manifest["cameras"][o.name] = dict(
                pos=b2t(pos), target=b2t(pos + fwd * 2.0), up=b2t(up), lens=d.lens,
                sensor=d.sensor_width if d.sensor_fit != 'VERTICAL' else d.sensor_height,
                fit=d.sensor_fit, shift=[d.shift_x, d.shift_y],
                fstop=d.dof.aperture_fstop if d.dof.use_dof else None,
                focus=d.dof.focus_distance if d.dof.use_dof else None)
        if o.type == 'LIGHT' and o.data.type == 'SPOT':
            m = o.matrix_world
            fwd = (m.to_3x3() @ Vector((0, 0, -1))).normalized()
            manifest["spots"].append(dict(name=o.name, pos=b2t(m.translation), dir=b2t(fwd),
                                          energy=o.data.energy, color=list(o.data.color),
                                          angle=math.degrees(o.data.spot_size), blend=o.data.spot_blend,
                                          radius=o.data.shadow_soft_size))
    cam = sc.objects.get("Cam_07_Percorso")
    if cam:
        for f in range(1, 381, 10):
            sc.frame_set(f)
            m = cam.matrix_world
            fwd = (m.to_3x3() @ Vector((0, 0, -1))).normalized()
            manifest["path"].append(dict(f=f, pos=b2t(m.translation), target=b2t(m.translation + fwd * 2)))
        sc.frame_set(1)

    # ---------------------------------------------------- unione per gruppo
    export_objs = []
    for g in GROUPS:
        objs = [o for o in sc.objects if o.get("bake_group") == g]
        if not objs:
            continue
        gloss = g in GLOSS_GROUPS
        info = {"res": GROUPS[g], "gloss": gloss, "materials": {}}
        base = bpy.data.materials.new("G_" + g)
        cache = {}
        for o in objs:
            me = o.data
            for nm_uv in [u.name for u in me.uv_layers if u.name != "bake" and not u.name.startswith(".")]:
                uvl = me.uv_layers.get(nm_uv)
                if uvl is not None:
                    me.uv_layers.remove(uvl)
            if gloss:
                for i, s in enumerate(me.materials):
                    om = s
                    key = om.name if om else "none"
                    if key not in cache:
                        nm = bpy.data.materials.new("%s__%s" % (g, key))
                        cache[key] = nm
                        pr = mat_params(om) if om else dict(rough=0.5, metal=0, coat=0, trans=0)
                        if key.startswith("Glassa_Fondente"):
                            pr["rough"] = 0.22   # rugosita' procedurale: valore medio
                        pr["color"] = principled_color(om) if om else None
                        info["materials"][nm.name] = pr
                    me.materials[i] = cache[key]
            else:
                me.materials.clear()
                me.materials.append(base)
                for p in me.polygons:
                    p.material_index = 0
        if not gloss:
            info["materials"][base.name] = {}
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.parent = None
            o.select_set(True)
        vl.objects.active = objs[0]
        if len(objs) > 1:
            bpy.ops.object.join()
        j = vl.objects.active
        j.name = "G_" + g
        j.data.name = "G_" + g
        # trasformazioni applicate: GLB con nodi a identita'
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        info["tris"] = sum(len(p.vertices) - 2 for p in j.data.polygons)
        manifest["groups"][g] = info
        export_objs.append(j)
        print("GROUP", g, len(objs), "->", info["tris"], "tris")

    bpy.ops.object.select_all(action='DESELECT')
    for o in export_objs:
        o.select_set(True)
    out = os.path.join(HERE, "out", "galleria_raw.glb")
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_yup=True,
                              export_texcoords=True, export_normals=True, export_tangents=False,
                              export_materials='EXPORT', export_cameras=False, export_lights=False,
                              export_apply=False, export_extras=False, export_animations=False,
                              export_attributes=False, export_image_format='NONE')
    with open(os.path.join(PUB, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    print("EXPORTED", out)


main()
