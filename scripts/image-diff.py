#!/usr/bin/env python3
"""PSNR and SSIM between pairs of shots *_a.png / *_b.png (before and after compression). The background is masked out."""
import sys, glob, os
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

def ssim(a, b):
    a = a.astype(np.float64); b = b.astype(np.float64)
    C1, C2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mu_a, mu_b = gaussian_filter(a, 1.5), gaussian_filter(b, 1.5)
    s_aa = gaussian_filter(a * a, 1.5) - mu_a ** 2; s_bb = gaussian_filter(b * b, 1.5) - mu_b ** 2; s_ab = gaussian_filter(a * b, 1.5) - mu_a * mu_b
    return ((2 * mu_a * mu_b + C1) * (2 * s_ab + C2)) / ((mu_a ** 2 + mu_b ** 2 + C1) * (s_aa + s_bb + C2))

rows = []
for fa in sorted(glob.glob(os.path.join(sys.argv[1], '*_a.png'))):
    fb = fa[:-6] + '_b.png'
    if not os.path.exists(fb): continue
    a = np.array(Image.open(fa).convert('RGB')).astype(np.float64); b = np.array(Image.open(fb).convert('RGB')).astype(np.float64)
    bg = np.median(a.reshape(-1, 3), axis=0)
    mask = (np.abs(a - bg).sum(-1) > 12) | (np.abs(b - bg).sum(-1) > 12)       # only the model itself
    if mask.sum() < 100: continue
    mse = ((a - b) ** 2).mean(-1)[mask].mean()
    p = 99.0 if mse == 0 else 10 * np.log10(255 ** 2 / mse)
    ya, yb = a @ [0.299, 0.587, 0.114], b @ [0.299, 0.587, 0.114]
    s = ssim(ya, yb)[mask].mean()
    diff = np.abs(a - b).max(-1)[mask]
    rows.append((os.path.basename(fa)[:-6], p, s, np.percentile(diff, 99)))
    print(f'{os.path.basename(fa)[:-6]:28s} PSNR {p:5.1f} дБ   SSIM {s:.4f}   99% пикселей отличаются меньше чем на {np.percentile(diff, 99):.0f}/255')
if rows:
    print(f'\nсреднее: PSNR {np.mean([r[1] for r in rows]):.1f} дБ, SSIM {np.mean([r[2] for r in rows]):.4f}, худший PSNR {min(r[1] for r in rows):.1f} ({min(rows, key=lambda r: r[1])[0]})')
