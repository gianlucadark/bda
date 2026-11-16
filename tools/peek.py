import bpy, sys, os
a=sys.argv[sys.argv.index('--')+1:]
src, dst = a[0], a[1]; crop = [float(x) for x in a[2].split(',')] if len(a)>2 else None
im=bpy.data.images.load(os.path.abspath(src))
w,h=im.size
if crop:
    import numpy as np
    px=np.empty(w*h*4,dtype=np.float32); im.pixels.foreach_get(px); px=px.reshape(h,w,4)
    x0,y0,x1,y1=[int(c*s) for c,s in zip(crop,(w,h,w,h))]
    sub=px[h-y1:h-y0, x0:x1]
    o=bpy.data.images.new('c',sub.shape[1],sub.shape[0]); o.pixels.foreach_set(sub.ravel()); o.file_format='PNG'; o.filepath_raw=os.path.abspath(dst); o.save()
else:
    im.scale(min(w,1024),min(h,1024)); im.file_format='PNG'; im.save(filepath=os.path.abspath(dst))
print('PEEK',dst)
