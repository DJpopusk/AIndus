"""Tunes the blend weights: SCENE_HEAD_W (share of the scene head in the scene score) and W0/W1 (face head weight).
python3 sweep_blend.py  uses the scene holdout (the same split as train_scene.py), the reel simulation and FairFace val.
"""
import json, random, numpy as np, warnings; warnings.filterwarnings('ignore')
H = json.load(open('head_b32.json')); WB, BB = np.array(H['Wbin']), H['bbin']; WS, BS = np.array(H['Wscene']), H['bscene']
P = json.load(open('prompts_b32.json'))['sets']; T = {k: np.array(v['emb']) for k, v in P.items()}
TZS = np.vstack([T['context'], T['person'], T['negative']]); NPOS = len(P['context']['labels']) + len(P['person']['labels'])
def softmax(z): z = z - z.max(-1, keepdims=True); e = np.exp(z); return e / e.sum(-1, keepdims=True)
sig = lambda x: 1 / (1 + np.exp(-x))

scene = json.load(open('emb_scene_b32.json'))['items']; ff = json.load(open('emb_ff_val_b32.json'))['items']
try: reel = json.load(open('emb_reelsim_b32.json'))['items']
except FileNotFoundError: reel = []
random.seed(3); by_root = {}
for i, it in enumerate(scene): by_root.setdefault(it['root'], []).append(i)
te = set()
for r, idx in by_root.items(): random.shuffle(idx); te.update(idx[:max(1, len(idx) // 4)])
hold = [it for i, it in enumerate(scene) if i in te]

def comps(items):
    X = np.array([it['emb'] for it in items]); zs = softmax(100 * X @ TZS.T)[:, :NPOS].sum(1); close = softmax(100 * X @ T['gate'].T)[:, 0]
    crops = [X] + [np.array([it[k] for it in items]) for k in ('emb_top', 'emb_center') if k in items[0]]
    pf = np.max([sig(c @ WB + BB) for c in crops], axis=0); ps = sig(X @ WS + BS)
    return zs, ps, pf, close
def final(c, a, w0, w1):
    zs, ps, pf, close = c; w = w0 + w1 * close
    return (1 - w) * ((1 - a) * zs + a * ps) + w * pf

ch, cf = comps(hold), comps(ff); cr = comps(reel) if reel else None
yh = np.array([it['label'] for it in hold]); gh = np.array([it['group'] for it in hold]); yf = np.array([it['race'] for it in ff])
LIFE = np.array([g.endswith('_life') and not g.startswith('ind') or g in ('flickr30k', 'coco') for g in gh])
DANCE = np.array([g in ('georgian', 'caucasus', 'slavic', 'turkish', 'mideast', 'casia', 'europe', 'latam', 'africa', 'asia', 'modern') for g in gh])
INDLIFE = np.array([g in ('ind_life', 'ind_people', 'ind_street', 'ind_city', 'ind_prof') for g in gh])
thr = 0.6
print('a=scene-head w | w0 w1 || holdout@0.6: recall(pos) recall(ind_life) FP(neg) FP(georgian) FP(dances) FP(lifestyle) || FairFace: rec ME oth' + (' || reel-sim: rec FP(geo)' if reel else ''))
for a in (0.5, 0.7, 0.85, 1.0):
    for w0, w1 in ((0.3, 0.5), (0.4, 0.4), (0.5, 0.3)):
        fh = final(ch, a, w0, w1); f_ = final(cf, a, w0, w1)
        line = f'{a:4.2f} | {w0:.1f} {w1:.1f} || {(fh[yh==1]>=thr).mean():.2f} {(fh[(yh==1)&INDLIFE]>=thr).mean():.2f} {(fh[yh==0]>=thr).mean():.2f} {(fh[gh=="georgian"]>=thr).mean():.2f} {(fh[DANCE]>=thr).mean():.2f} {(fh[LIFE]>=thr).mean():.2f} || {(f_[yf==1]>=thr).mean():.2f} {(f_[yf==4]>=thr).mean():.2f} {(f_[(yf!=1)&(yf!=4)]>=thr).mean():.2f}'
        if reel:
            fr = final(cr, a, w0, w1); yr = np.array([it['label'] for it in reel]); gr = np.array([it['group'] for it in reel])
            line += f' || {(fr[yr==1]>=thr).mean():.2f} {(fr[gr=="georgian"]>=thr).mean():.2f}'
        print(line)
