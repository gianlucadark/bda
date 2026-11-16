import bpy, sys, os, numpy as np
a=sys.argv[sys.argv.index('--')+1:]
out=a[0]; files=a[1:]; cols=3; tw=640
tiles=[]
for f in files:
    im=bpy.data.images.load(os.path.abspath(f)); w,h=im.size; th=int(tw*h/w); im.scale(tw,th)
    px=np.empty(tw*th*4,np.float32); im.pixels.foreach_get(px); tiles.append(px.reshape(th,tw,4))
th=tiles[0].shape[0]; rows=(len(tiles)+cols-1)//cols
W,H=cols*tw+(cols+1)*8, rows*th+(rows+1)*8
canvas=np.ones((H,W,4),np.float32)*0.1; canvas[...,3]=1
for i,t in enumerate(tiles):
    r,c=divmod(i,cols); y=H-(r+1)*(th+8); x=8+c*(tw+8)
    canvas[y:y+t.shape[0],x:x+tw]=t
o=bpy.data.images.new('m',W,H); o.pixels.foreach_set(canvas.ravel()); o.filepath_raw=os.path.abspath(out); o.file_format='JPEG'; o.save()
print('MONT',out)
