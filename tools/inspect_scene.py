import bpy
sc = bpy.data.scenes["BDA_Galleria"]
dg = bpy.context.evaluated_depsgraph_get()
rows=[]
for o in sc.objects:
    if o.type in ('MESH','CURVE','FONT'):
        if o.hide_render: continue
        e=o.evaluated_get(dg)
        try: me=e.to_mesh()
        except: continue
        n=len(me.polygons); mats=[m.name for m in o.material_slots if m.material] if hasattr(o,'material_slots') else []
        dims=tuple(round(d,2) for d in o.dimensions)
        coll=o.users_collection[0].name
        rows.append((coll,o.name,o.type,n,dims,",".join(mats),len(me.uv_layers),[m.type for m in o.modifiers]))
        e.to_mesh_clear()
rows.sort()
for r in rows: print("OBJ",*r,sep=" | ")
print("TOTAL OBJ",len(rows),"POLYS",sum(r[3] for r in rows))
for m in bpy.data.materials:
    if m.users==0: continue
    p=[n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED'] if m.node_tree else []
    info=[]
    for n in p:
        def v(k):
            i=n.inputs.get(k); 
            if i is None: return None
            return 'L' if i.is_linked else (round(i.default_value,3) if isinstance(i.default_value,float) else None)
        info.append(dict(metal=v('Metallic'),rough=v('Roughness'),trans=v('Transmission Weight'),sss=v('Subsurface Weight'),coat=v('Coat Weight'),em=v('Emission Strength')))
    other=[n.type for n in m.node_tree.nodes if n.type.startswith('BSDF') or n.type in('EMISSION','MIX_SHADER')] if m.node_tree else []
    print("MAT",m.name,m.users,info,other)
for o in sc.objects:
    if o.type=='CAMERA': print("CAM",o.name,tuple(round(x,3) for x in o.matrix_world.translation),o.data.lens, o.data.sensor_width, o.data.sensor_fit, o.data.shift_x,o.data.shift_y)
print("VIEW",sc.view_settings.view_transform,sc.view_settings.look,sc.view_settings.exposure)
