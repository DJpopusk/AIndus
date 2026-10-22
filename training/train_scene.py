"""Scene head: Indian/South Asian scene against Georgian, Caucasian, Slavic, Turkish, Latin, African, Asian
and modern dances, other weddings, streets and so on.

python3 train_scene.py            reads emb_scene_b32.json (+ prompts_b32.json, head_b32.json, emb_ff_val_b32.json,
                                  emb_user_b32.json and emb_shared_b32.json when present),
                                  prints per-group metrics and writes Wscene/bscene into head_b32.json
"""
import json, random, sys, numpy as np, warnings; warnings.filterwarnings('ignore')
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

b = 'b32'
d = json.load(open(f'emb_scene_{b}.json'))
items = d['items']
random.seed(3)
# 25% holdout inside each root category (so every group is represented)
by_root = {}
for i, it in enumerate(items): by_root.setdefault(it['root'], []).append(i)
test_idx = set()
for root, idx in by_root.items():
    random.shuffle(idx); test_idx.update(idx[:max(1, len(idx) // 4)])
# frames from a real feed labelled by users (import_user_dataset.py), with a higher weight
import os
USER_W = float(os.environ.get('USER_WEIGHT', 2))
if os.path.exists(f'emb_user_{b}.json'):
    user = json.load(open(f'emb_user_{b}.json'))['items']
    for i, it in enumerate(user):
        by_root.setdefault(it['root'], []).append(len(items))
        if random.random() < 0.25: test_idx.add(len(items))
        items.append(it)
    print(f'+ {len(user)} кадров из пользовательского датасета (вес {USER_W})')
# shared dataset: labels from everyone who agreed to share (fetch_shared_dataset.py), embeddings only
SHARED_W = float(os.environ.get('SHARED_WEIGHT', 1.5))
if os.path.exists(f'emb_shared_{b}.json'):
    shared = json.load(open(f'emb_shared_{b}.json'))['items']
    for it in shared:
        by_root.setdefault(it['root'], []).append(len(items))
        if random.random() < 0.25: test_idx.add(len(items))
        items.append(it)
    print(f'+ {len(shared)} меток из общего датасета (вес {SHARED_W})')
X = np.array([it['emb'] for it in items], dtype=np.float32); y = np.array([it['label'] for it in items])
sw = np.array([USER_W if str(it.get('group', '')).startswith('user') else SHARED_W if str(it.get('group', '')).startswith('shared') else 1.0 for it in items])
grp = np.array([it['group'] for it in items])
tr = np.array([i not in test_idx for i in range(len(items))]); te = ~tr
print(f'scene dataset: {len(items)} images, train {tr.sum()}, holdout {te.sum()}; pos {y.sum()}, neg {(1-y).sum()}')

best = None
for C in [0.1, 0.3, 1, 3]:
    clf = LogisticRegression(C=C, max_iter=5000, class_weight='balanced').fit(X[tr], y[tr], sample_weight=sw[tr])
    p = clf.predict_proba(X[te])[:, 1]
    auc = roc_auc_score(y[te], p); acc = ((p >= 0.5) == y[te]).mean()
    print(f'  C={C}: holdout AUC {auc:.3f} acc@0.5 {acc:.3f}')
    if best is None or auc > best[0]: best = (auc, C, clf)
clf = best[2]
p_scene = clf.predict_proba(X)[:, 1]

# ---- comparison with zero-shot and the full formula ----
P = json.load(open(f'prompts_{b}.json'))['sets']
T = {k: np.array(v['emb']) for k, v in P.items()}
TZS = np.vstack([T['context'], T['person'], T['negative']]); NPOS = len(P['context']['labels']) + len(P['person']['labels'])
H = json.load(open(f'head_{b}.json')); WB, BB = np.array(H['Wbin']), H['bbin']
def softmax(z): z = z - z.max(-1, keepdims=True); e = np.exp(z); return e / e.sum(-1, keepdims=True)
zs = softmax(100 * X @ TZS.T)[:, :NPOS].sum(1)
close = softmax(100 * X @ T['gate'].T)[:, 0]
crops = [X] + [np.array([it[k] for it in items], dtype=np.float32) for k in ('emb_top', 'emb_center') if k in items[0]]
p_face = np.max([1 / (1 + np.exp(-(c @ WB + BB))) for c in crops], axis=0)
w = 0.3 + 0.5 * close
def final(scene): return (1 - w) * scene + w * p_face

# old prompts (v2, no dances) for before/after
old = json.load(open('prompts_v2_b32.json'))['sets'] if __import__('os').path.exists('prompts_v2_b32.json') else None
variants = {}
if old:
    TO = np.vstack([np.array(old['context']['emb']), np.array(old['person']['emb']), np.array(old['negative']['emb'])])
    NO = len(old['context']['labels']) + len(old['person']['labels'])
    zs_old = softmax(100 * X @ TO.T)[:, :NO].sum(1)
    variants['v2: старые подсказки'] = final(zs_old)
variants['v3: подсказки+танцы'] = final(zs)
variants['v3 + сценовая голова'] = final(0.5 * zs + 0.5 * p_scene)
variants['только сценовая голова'] = final(p_scene)

thr = 0.6
groups = sorted(set(grp))
print(f'\nдоля кадров ≥ {thr} на holdout по группам (для label 1 это полнота, для label 0 — ложные срабатывания):')
print('  ' + 'группа'.ljust(14) + ' n  ' + '  '.join(k.ljust(22) for k in variants))
for g in groups:
    m = te & (grp == g)
    if m.sum() == 0: continue
    print('  ' + g.ljust(14) + f'{m.sum():3d} ' + '  '.join(f'{(v[m] >= thr).mean():.2f}'.ljust(22) for v in variants.values()))
LIFE = np.array([g.endswith('_life') and not g.startswith('ind') or g in ('flickr30k', 'coco') for g in grp])
DANCE = np.array([g in ('georgian', 'caucasus', 'slavic', 'turkish', 'mideast', 'casia', 'europe', 'latam', 'africa', 'asia', 'modern') for g in grp])
for k, v in variants.items():
    print(f'{k:24s} holdout AUC {roc_auc_score(y[te], v[te]):.3f} | recall(pos) {(v[te & (y == 1)] >= thr).mean():.2f} | FP(neg) {(v[te & (y == 0)] >= thr).mean():.2f} | FP(georgian) {(v[te & (grp == "georgian")] >= thr).mean():.2f} | FP(other dances) {(v[te & DANCE] >= thr).mean():.2f} | FP(lifestyle) {(v[te & LIFE] >= thr).mean():.2f}')

# ---- faces: FairFace val must not get worse ----
ff = json.load(open(f'emb_ff_val_{b}.json'))['items']
Xf = np.array([it['emb'] for it in ff]); yf = np.array([it['race'] for it in ff])
zsf = softmax(100 * Xf @ TZS.T)[:, :NPOS].sum(1); closef = softmax(100 * Xf @ T['gate'].T)[:, 0]
pf = 1 / (1 + np.exp(-(Xf @ WB + BB))); psf = clf.predict_proba(Xf)[:, 1]; wf = 0.3 + 0.5 * closef
for name, scene in (('v3', zsf), ('v3+scene', 0.5 * zsf + 0.5 * psf)):
    s = (1 - wf) * scene + wf * pf
    print(f'FairFace val {name:9s}: Indian recall {(s[yf == 1] >= thr).mean():.2f} | ME→Indian {(s[yf == 4] >= thr).mean():.2f} | others→Indian {(s[(yf != 1) & (yf != 4)] >= thr).mean():.2f}')

H['Wscene'] = clf.coef_[0].round(5).tolist(); H['bscene'] = round(float(clf.intercept_[0]), 5)
H['scene_val'] = {'auc': round(float(best[0]), 4), 'n_train': int(tr.sum()), 'n_holdout': int(te.sum())}
json.dump(H, open(f'head_{b}.json', 'w'))
print('saved Wscene/bscene into', f'head_{b}.json')
