import bpy, collections
B=collections.defaultdict(lambda:[9,9,-9,-9])
for o in bpy.context.scene.objects:
    g=o.get("bake_group")
    if not g: continue
    uv=o.data.uv_layers["bake"].data
    xs=[d.uv.x for d in uv]; ys=[d.uv.y for d in uv]
    b=B[g]; b[0]=min(b[0],min(xs)); b[1]=min(b[1],min(ys)); b[2]=max(b[2],max(xs)); b[3]=max(b[3],max(ys))
    if g in('mono','walls','name'): print("UVB",g,o.name,round(min(xs),3),round(min(ys),3),round(max(xs),3),round(max(ys),3), tuple(round(s,2) for s in o.scale), len(o.data.polygons))
for g,b in B.items(): print("UVB",g,[round(x,3) for x in b])
