import bpy, os
R=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P=os.path.join(R,'..','BDA_Galleria_Demo','previews')
out=os.path.join(R,'public','img'); os.makedirs(out,exist_ok=True)
sc=bpy.context.scene
for src,dst,w in (('02_ingresso.png','poster_ingresso.webp',1600),('06_mobile_9x16.png','poster_mobile.webp',1080),('01_hero.png','og_hero.webp',1600)):
    im=bpy.data.images.load(os.path.join(P,src))
    if im.size[0]>w: im.scale(w,int(im.size[1]*w/im.size[0]))
    im.file_format='WEBP'; im.save(filepath=os.path.join(out,dst),quality=82); print('IMG',dst,im.size[:])
m=bpy.data.images.load(os.path.join(R,'public','scene','tex','mono_mask.png'))
print('MASK',m.size[:],m.channels)
