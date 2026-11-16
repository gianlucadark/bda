"""Sonda HDR equirettangolare per i riflessi live (glasse, porcellana, cioccolato).

  blender -b <BDA_Galleria.blend> --python tools/probe_web.py -- [--samples 256] [--w 1024]

Renderizza con Cycles un panorama 360 dal punto davanti ai piedistalli e salva
public/scene/env.hdr (radianza lineare, gia' scalata dell'esposizione +0.3 EV).
I dolci piccoli vengono nascosti: non devono riflettere se stessi.
"""
import bpy, os, sys, math, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(os.path.dirname(HERE), "public", "scene")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", type=int, default=256)
    ap.add_argument("--w", type=int, default=1024)
    ap.add_argument("--pos", default="0.62,2.75,1.30")
    a = ap.parse_args(argv)
    sc = bpy.context.scene
    for o in sc.objects:
        n = o.name
        if n.startswith(("Cupola_", "Strati_", "Tartelletta_", "Didascalia_")):
            o.hide_render = True
        if o.type == 'LIGHT':
            try:
                o.visible_camera = True
            except Exception:
                pass
    cd = bpy.data.cameras.new("Probe")
    cd.type = 'PANO'
    try:
        cd.panorama_type = 'EQUIRECTANGULAR'
    except Exception:
        cd.cycles.panorama_type = 'EQUIRECTANGULAR'
    co = bpy.data.objects.new("Probe", cd)
    sc.collection.objects.link(co)
    co.location = [float(x) for x in a.pos.split(",")]
    # equirettangolare Cycles: camera con asse ottico orizzontale verso +X del mondo
    co.rotation_euler = (math.radians(90), 0, math.radians(-90))
    sc.camera = co
    sc.render.resolution_x, sc.render.resolution_y = a.w, a.w // 2
    sc.render.resolution_percentage = 100
    cy = sc.cycles
    cy.samples = a.samples
    cy.use_denoising = True
    cy.use_adaptive_sampling = True
    sc.render.film_transparent = False
    # radianza lineare: niente view transform sul file, l'esposizione la applico al pixel
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.view_settings.exposure = 0.0
    st = sc.render.image_settings
    st.file_format = 'HDR'
    os.makedirs(PUB, exist_ok=True)
    out = os.path.join(PUB, "env.hdr")
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print("PROBE", out)


main()
