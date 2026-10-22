#!/usr/bin/env python3
"""Compresses 3D models without visible quality loss.

    python3 scripts/compress-models.py            -> all models of people, gods, cows, animals and vehicles
    python3 scripts/compress-models.py kurta2.glb -> only these files
    python3 scripts/compress-models.py --dry      -> report sizes, replace nothing
    python3 scripts/compress-models.py --out people_c kurta2.glb -> compressed copy in models/people_c (for comparison)

Originals are moved once to assets-src/models/ (next to extension/) and compressed from there, so the script can be
rerun with other settings. The result replaces the originals in extension/assets/models/.

What is done and why (numbers are measurements on our models, scripts/image-diff.py):
  * geometry: meshopt (EXT_meshopt_compression) with quantisation, 16 bits for positions and texture coordinates,
    12 for normals. Going lower does not work: with 12-bit UVs the sari weave slid around (close-up 31 dB instead
    of 44), and 16 bits cost almost nothing over 12. Skin weights are 16 bits too: the second Modi's rest pose is
    far from the bind pose, and 8-bit weights moved vertices by millimetres (33 dB instead of 50).
    The overlay unpacks it with the bundled MeshoptDecoder;
  * normal, metalness and occlusion maps: WebP near-lossless 60. Mean normal direction error is 0.2-0.6 degrees,
    under 1.3 degrees for 99% of pixels. Plain lossy WebP does not fit here: it subsamples chroma, and at q95 1% of
    pixels had normals off by 12-30 degrees, which shows as blotches on skin;
  * colour without alpha: WebP q95 (about 45 dB against the source). If a fine pattern drops below 42 dB (WebP stores
    colour at half resolution, which is how the sari lost its weave), near-lossless is used, and lossless if that is
    still not enough. Every texture is checked after compression;
  * colour with alpha (hair, eyelashes): lossless WebP with -exact, otherwise the encoder wipes the colour under
    transparent pixels and strands get a dark fringe.
Texture resolution does not change.
"""
import io, json, os, shutil, struct, subprocess, sys, tempfile
import numpy as np
from PIL import Image

MIN_PSNR = 42.0     # no texture may be worse than this (dB against the source), otherwise a gentler mode is used

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DST = os.path.join(ROOT, 'extension', 'assets', 'models')
SRC = os.path.join(ROOT, 'assets-src', 'models')
DIRS = ['people']


def read_glb(path):
    b = open(path, 'rb').read()
    jl = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + jl])
    off = 20 + jl
    bl = struct.unpack('<I', b[off:off + 4])[0]
    return j, bytearray(b[off + 8:off + 8 + bl])


def write_glb(path, j, bin_):
    js = json.dumps(j, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    bin_ = bytes(bin_) + b'\0' * ((4 - len(bin_) % 4) % 4)
    out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bin_))
    out += struct.pack('<I', len(js)) + b'JSON' + js + struct.pack('<I', len(bin_)) + b'BIN\0' + bin_
    open(path, 'wb').write(out)


def cwebp(img, args):
    with tempfile.TemporaryDirectory() as d:
        src, dst = os.path.join(d, 'a.png'), os.path.join(d, 'a.webp')
        img.save(src)
        subprocess.run(['cwebp', '-quiet', '-mt', *args, src, '-o', dst], check=True)
        return open(dst, 'rb').read()


def psnr(img, enc):
    a = np.asarray(img, dtype=np.float64)
    b = np.asarray(Image.open(io.BytesIO(enc)).convert(img.mode), dtype=np.float64)
    if img.mode == 'RGBA':                          # colour under transparent pixels is invisible, so it is not counted
        m = a[..., 3] > 0
        a, b = a[m][:, :3], b[m][:, :3]
    mse = np.mean((a - b) ** 2)
    return 99.0 if mse == 0 else 10 * np.log10(255 ** 2 / mse)


def encode(img, k, has_alpha):
    """colour: q95 -> near-lossless -> lossless until MIN_PSNR is reached; normals and masks: near-lossless"""
    exact = ['-exact'] if has_alpha else []
    if k == 'color':
        tries = [('без потерь', ['-lossless', '-exact', '-z', '6'])] if has_alpha else \
                [('q95', ['-q', '95', '-m', '6', '-sharp_yuv']), ('near-lossless', ['-near_lossless', '60', '-z', '6']), ('без потерь', ['-lossless', '-z', '6'])]
    else:
        tries = [('near-lossless', ['-near_lossless', '60', '-z', '6'] + exact), ('без потерь', ['-lossless', '-z', '6'] + exact)]
    for how, args in tries:
        enc = cwebp(img, args)
        q = psnr(img, enc) if k == 'color' else 99.0      # normals were checked separately: near-lossless stays within 1.3 degrees for 99% of pixels
        if q >= MIN_PSNR:
            return enc, how, q
    return enc, how, q


def slots(j):
    """which image sits in which material slot"""
    out = {}
    for m in j.get('materials', []):
        pb = m.get('pbrMetallicRoughness', {})
        for k, t in [('color', pb.get('baseColorTexture')), ('color', m.get('emissiveTexture')), ('normal', m.get('normalTexture')),
                     ('mask', pb.get('metallicRoughnessTexture')), ('mask', m.get('occlusionTexture'))]:
            if t is None:
                continue
            tex = j['textures'][t['index']]
            src = tex.get('source', tex.get('extensions', {}).get('EXT_texture_webp', {}).get('source'))
            if src is not None:
                out.setdefault(src, k)
    return out


def recompress_textures(path_in, path_out):
    j, bin_ = read_glb(path_in)
    kind = slots(j)
    views = j.get('bufferViews', [])
    new_data = {}                                   # bufferView index -> new bytes
    report = []
    for i, im in enumerate(j.get('images', [])):
        if 'bufferView' not in im or im.get('mimeType') == 'image/webp':
            continue
        bv = views[im['bufferView']]
        data = bytes(bin_[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']])
        img = Image.open(io.BytesIO(data))
        k = kind.get(i, 'mask')
        has_alpha = img.mode in ('RGBA', 'LA', 'PA') or (img.mode == 'P' and 'transparency' in img.info)
        if has_alpha:
            img = img.convert('RGBA')
            has_alpha = img.getchannel('A').getextrema()[0] < 255
        img = img.convert('RGBA' if has_alpha else 'RGB')
        enc, how, q = encode(img, k, has_alpha)
        if len(enc) >= len(data):                  # happens on small masks: keep the original
            continue
        new_data[im['bufferView']] = enc
        im['mimeType'] = 'image/webp'
        report.append((k, how, len(data), len(enc), q))
    if not new_data:
        shutil.copy(path_in, path_out)
        return report
    # rebuild the binary chunk: all bufferViews in order, images replaced, 4-byte alignment
    out = bytearray()
    for vi, bv in enumerate(views):
        chunk = new_data.get(vi) or bytes(bin_[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']])
        out += b'\0' * ((4 - len(out) % 4) % 4)
        bv['byteOffset'] = len(out)
        bv['byteLength'] = len(chunk)
        out += chunk
    j['buffers'][0]['byteLength'] = len(out)
    webp_images = {i for i, im in enumerate(j['images']) if im.get('mimeType') == 'image/webp'}
    for t in j.get('textures', []):
        if t.get('source') in webp_images:
            t.setdefault('extensions', {})['EXT_texture_webp'] = {'source': t.pop('source')}
    for key in ('extensionsUsed', 'extensionsRequired'):
        j[key] = sorted(set(j.get(key, [])) | {'EXT_texture_webp'})
    write_glb(path_out, j, out)
    return report


def meshopt(path_in, path_out):
    subprocess.run(['npx', '--yes', '@gltf-transform/cli@4', 'meshopt', path_in, path_out, '--level', 'medium',
                    '--quantize-position', '16', '--quantize-normal', '12', '--quantize-texcoord', '16', '--quantize-weight', '16'],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    dry = '--dry' in sys.argv
    only = {a for a in sys.argv[1:] if a.endswith('.glb')}
    out_dir = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else None   # put the compressed copy elsewhere (for comparison)
    total_in = total_out = 0
    for sub in DIRS:
        dst_dir, src_dir = os.path.join(DST, sub), os.path.join(SRC, sub)
        if not os.path.isdir(dst_dir):
            continue
        os.makedirs(src_dir, exist_ok=True)
        for f in sorted(os.listdir(dst_dir)):
            if not f.endswith('.glb') or (only and f not in only):
                continue
            orig = os.path.join(src_dir, f)
            if not os.path.exists(orig):            # first run: move the original to assets-src
                shutil.copy2(os.path.join(dst_dir, f), orig)
            with tempfile.TemporaryDirectory() as d:
                a, b = os.path.join(d, 'tex.glb'), os.path.join(d, 'out.glb')
                rep = recompress_textures(orig, a)
                meshopt(a, b)
                n_in, n_out = os.path.getsize(orig), os.path.getsize(b)
                total_in += n_in; total_out += n_out
                worst = min([q for *_, q in rep if q < 99] or [99])
                modes = sorted({f'{k}/{h}' for k, h, *_ in rep})
                tex = f'текстур {len(rep)}: ' + ', '.join(modes) + (f'; худший цвет {worst:.1f} дБ' if worst < 99 else '')
                print(f'{os.path.join(sub, f):32s} {n_in / 1e6:6.1f} → {n_out / 1e6:5.1f} МБ  {tex}', flush=True)
                if out_dir:
                    os.makedirs(os.path.join(DST, out_dir), exist_ok=True)
                    shutil.copy(b, os.path.join(DST, out_dir, f))
                elif not dry:
                    shutil.copy(b, os.path.join(dst_dir, f))
    print(f'\nвсего: {total_in / 1e6:.0f} → {total_out / 1e6:.0f} МБ ({100 - 100 * total_out / max(1, total_in):.0f} % меньше)')


if __name__ == '__main__':
    main()
