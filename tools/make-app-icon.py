"""从用户给的角色图生成应用图标与官方 logo。

素材  images/icon-source-*.png  (1024x1024,白底,脸部特写;找不到时回退到旧素材)
输出  build/icon.ico   多尺寸(16/24/32/48/64/128/256)
      build/icon.png   1024x1024 透明底
      build/tray.png   32x32 透明底(托盘)
      public/logo.png  128x128 应用内 logo(打包进 asar,渲染层用)

去白底:只删**与画布边缘连通**的近白像素(洪水填充),所以角色白色头发/衣服、
蓝色圆环内部的浅色都不会被误删;边缘做轻微羽化避免锯齿。
小尺寸(16/24)额外做一次轻缩放 + 提对比,否则缩到 16px 认不出内容。
"""
import glob
import io
import os
import struct
from collections import deque

from PIL import Image, ImageChops, ImageEnhance, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SRC_CANDIDATES = (
    sorted(glob.glob(os.path.join(ROOT, 'images', 'icon-source-*.png')))
    + sorted(glob.glob(os.path.join(ROOT, 'images', '23-59-47_*.png')))
)
SRC = _SRC_CANDIDATES[0]
OUT = os.path.join(ROOT, 'build')
TOL = 7           # 与背景色的最大通道差。角色身上有接近纯白的部分,阈值必须很小
FEATHER = 0.7     # 透明边缘羽化半径
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def background_color(img):
    w, h = img.size
    pts = [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)]
    px = [img.getpixel(p) for p in pts]
    px.sort(key=lambda c: sum(c))
    return px[len(px) // 2]


def cutout():
    img = Image.open(SRC).convert('RGB')
    w, h = img.size
    bg = background_color(img)
    print('素材', os.path.basename(SRC), (w, h), 'bg', bg)

    diff = ImageChops.difference(img, Image.new('RGB', (w, h), bg)).convert('L')
    cand = diff.point(lambda v: 255 if v <= TOL else 0, mode='L')

    px = cand.load()
    seen = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if px[x, y] > 0 and not seen[y * w + x]:
                seen[y * w + x] = 1
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if px[x, y] > 0 and not seen[y * w + x]:
                seen[y * w + x] = 1
                q.append((x, y))

    removed = 0
    while q:
        x, y = q.popleft()
        removed += 1
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h:
                i = ny * w + nx
                if not seen[i] and px[nx, ny] > 0:
                    seen[i] = 1
                    q.append((nx, ny))
    print('去背景 %.1f%%' % (100.0 * removed / (w * h)))
    for name, (sx, sy) in (('corner', (6, 6)), ('face', (512, 560)), ('hair', (300, 300))):
        print('   采样 %-7s alpha=%d' % (name, 0 if seen[sy * w + sx] else 255))

    alpha = Image.frombytes('L', (w, h), bytes(255 if not s else 0 for s in seen))
    alpha = alpha.filter(ImageFilter.GaussianBlur(FEATHER))
    out = img.convert('RGBA')
    out.putalpha(alpha)
    return out


def square(img, pad=1.02):
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)
    side = int(max(img.size) * pad)
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - img.size[0]) // 2, (side - img.size[1]) // 2), img)
    return canvas


def write_ico(path, entries):
    blobs = []
    for size, im in entries:
        buf = io.BytesIO()
        im.convert('RGBA').save(buf, format='PNG')
        blobs.append((size, buf.getvalue()))

    header = struct.pack('<HHH', 0, 1, len(blobs))
    offset = 6 + 16 * len(blobs)
    dirs = b''
    for size, data in blobs:
        dirs += struct.pack(
            '<BBBBHHII',
            0 if size >= 256 else size,
            0 if size >= 256 else size,
            0, 0, 1, 32, len(data), offset,
        )
        offset += len(data)
    with open(path, 'wb') as fp:
        fp.write(header)
        fp.write(dirs)
        for _, data in blobs:
            fp.write(data)


def main():
    os.makedirs(OUT, exist_ok=True)
    art = square(cutout())
    icon = art.resize((1024, 1024), Image.LANCZOS)

    # 极小尺寸:再往里收一点(去掉外圈留白),并提对比 —— 16px 下只剩五官可认
    w, h = art.size
    zoom = int(w * 0.10)
    face = square(art.crop((zoom, zoom, w - zoom, h - zoom)), pad=1.0)
    face = ImageEnhance.Contrast(face).enhance(1.18)
    face = ImageEnhance.Color(face).enhance(1.12)

    icon.save(os.path.join(OUT, 'icon.png'))

    entries = []
    for size in ICO_SIZES:
        src = face if size <= 24 else art
        entries.append((size, src.resize((size, size), Image.LANCZOS)))
    write_ico(os.path.join(OUT, 'icon.ico'), entries)

    face.resize((32, 32), Image.LANCZOS).save(os.path.join(OUT, 'tray.png'))
    face.resize((16, 16), Image.LANCZOS).save(os.path.join(OUT, 'icon-16-preview.png'))
    art.resize((48, 48), Image.LANCZOS).save(os.path.join(OUT, 'icon-48-preview.png'))

    pub = os.path.join(ROOT, 'public')
    os.makedirs(pub, exist_ok=True)
    art.resize((128, 128), Image.LANCZOS).save(os.path.join(pub, 'logo.png'))

    print('wrote build/icon.ico / icon.png / tray.png / public/logo.png')


if __name__ == '__main__':
    main()
