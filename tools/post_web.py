"""Denoise (OpenImageDenoise) + tonemapping AgX dei lightmap grezzi -> WebP.

  blender -b --factory-startup --python tools/post_web.py -- [--groups a,b] [--quality 92]

Legge tools/out/raw/<gruppo>.exr (radianza lineare del bake COMBINED) e scrive
public/scene/tex/<gruppo>.webp (piena risoluzione) e <gruppo>_m.webp (meta', mobile).
Il tonemapping e' lo stesso dei render Cycles (AgX, Medium High Contrast, +0.3 EV),
quindi nel browser il colore cotto si mostra senza ulteriore tone mapping.
"""
import bpy, os, sys, argparse, time

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "out", "raw")
TEX = os.path.join(os.path.dirname(HERE), "public", "scene", "tex")
os.makedirs(TEX, exist_ok=True)


def color_manage(s):
    s.display_settings.display_device = 'sRGB'
    s.view_settings.view_transform = 'AgX'
    s.view_settings.look = 'AgX - Medium High Contrast'
    s.view_settings.exposure = 0.3
    s.view_settings.gamma = 1.0
    s.sequencer_colorspace_settings.name = 'sRGB'


def process(g, quality, denoise=True):
    src = os.path.join(RAW, g + ".exr")
    if not os.path.exists(src):
        print("MISSING", src)
        return
    img = bpy.data.images.load(src, check_existing=False)
    w, h = img.size
    s = bpy.data.scenes.new("post_" + g)
    s.render.engine = 'BLENDER_WORKBENCH'
    s.render.resolution_x, s.render.resolution_y = w, h
    s.render.resolution_percentage = 100
    s.render.use_compositing = True
    s.render.dither_intensity = 1.0
    color_manage(s)
    tree = bpy.data.node_groups.new("post_" + g, "CompositorNodeTree")
    s.compositing_node_group = tree
    tree.interface.new_socket(name="Image", in_out='OUTPUT', socket_type='NodeSocketColor')
    n_in = tree.nodes.new("CompositorNodeImage"); n_in.image = img
    n_out = tree.nodes.new("NodeGroupOutput")
    sock = n_in.outputs["Image"]
    if denoise:
        dn = tree.nodes.new("CompositorNodeDenoise")
        for k in ("HDR",):
            if k in dn.inputs:
                dn.inputs[k].default_value = True
        if "Prefilter" in dn.inputs:
            try:
                dn.inputs["Prefilter"].default_value = 'None'
            except Exception:
                pass
        if "Quality" in dn.inputs:
            try:
                dn.inputs["Quality"].default_value = 'High'
            except Exception:
                pass
        tree.links.new(sock, dn.inputs["Image"])
        sock = dn.outputs["Image"]
    tree.links.new(sock, n_out.inputs[0])
    st = s.render.image_settings
    st.file_format = 'WEBP'
    st.color_mode = 'RGB'
    st.quality = quality
    out = os.path.join(TEX, g + ".webp")
    s.render.filepath = out
    t = time.time()
    bpy.ops.render.render(write_still=True, scene=s.name)
    # versione mobile (meta' risoluzione)
    im2 = bpy.data.images.load(out, check_existing=False)
    im2.scale(max(1, w // 2), max(1, h // 2))
    im2.filepath_raw = os.path.join(TEX, g + "_m.webp")
    im2.file_format = 'WEBP'
    s.render.image_settings.quality = quality
    im2.save_render(os.path.join(TEX, g + "_m.webp"), scene=s) if False else im2.save(filepath=os.path.join(TEX, g + "_m.webp"), quality=quality)
    print("POST", g, w, "x", h, round(time.time() - t, 1), "s", flush=True)
    bpy.data.images.remove(im2)
    bpy.data.images.remove(img)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--groups", default="all")
    ap.add_argument("--quality", type=int, default=92)
    ap.add_argument("--no-denoise", action="store_true")
    a = ap.parse_args(argv)
    groups = [f[:-4] for f in sorted(os.listdir(RAW)) if f.endswith(".exr")] if a.groups == "all" else a.groups.split(",")
    for g in groups:
        process(g, a.quality, not a.no_denoise)


main()
