import bpy, bmesh, math, collections
sys_g=collections.defaultdict(lambda:[0,0,0])
for o in bpy.context.scene.objects:
    g=o.get("bake_group")
    if not g: continue
    bm=bmesh.new(); bm.from_mesh(o.data); bm.transform(o.matrix_world)
    uvl=bm.loops.layers.uv["bake"]
    wa=0; ua=0
    for f in bm.faces:
        wa+=f.calc_area()
        l=[lp[uvl].uv for lp in f.loops]
        a=0
        for i in range(1,len(l)-1):
            a+=abs((l[i]-l[0]).cross(l[i+1]-l[0]))/2
        ua+=a
    s=sys_g[g]; s[0]+=wa; s[1]+=ua; s[2]+=1
    bm.free()
for g,(wa,ua,n) in sys_g.items():
    res={'wall_curve':4096,'floor':4096,'walls':4096,'front':4096,'emit':256,'name':2048,'mono':1024,'pedestals':2048,'ped_tops':2048,'crea_matte':4096,'crea_gloss':4096,'awards':4096,'cafe_matte':1024,'cafe_gloss':2048,'signage':1024,'fixtures':512}[g]
    texel_mm = math.sqrt(wa/(ua*res*res))*1000 if ua else 0
    print("UVCHK %-11s n=%3d world=%8.3f m2 uvfill=%.2f texel=%.2f mm"%(g,n,wa,ua,texel_mm))
