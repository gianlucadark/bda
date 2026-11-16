import bpy, sys, os
a = sys.argv[sys.argv.index('--') + 1:]
im = bpy.data.images.load(os.path.abspath(a[0]))
im.file_format = 'WEBP'
im.save(filepath=os.path.abspath(a[1]), quality=82)
print('WEBP', a[1], im.size[:])
