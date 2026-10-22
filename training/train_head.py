"""Trains the face head on FairFace embeddings.
python3 train_head.py <backbone>  reads emb_ff_train_<b>.json / emb_ff_val_<b>.json, writes head_<b>.json
"""
import json, sys, numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import confusion_matrix

b = sys.argv[1]
RACES = ['East Asian', 'Indian', 'Black', 'White', 'Middle Eastern', 'Latino_Hispanic', 'Southeast Asian']
IND, ME = 1, 4

def load(f):
    d = json.load(open(f))
    X = np.array([it['emb'] for it in d['items']], dtype=np.float32)
    y = np.array([it['race'] for it in d['items']])
    return X, y, d

Xtr, ytr, _ = load(f'emb_ff_train_{b}.json')
Xva, yva, _ = load(f'emb_ff_val_{b}.json')
print(f'{b}: train {len(ytr)}, val {len(yva)}, dim {Xtr.shape[1]}')

# 7-class head: gives P(Indian) and, as a bonus, a confident not-Indian signal for the veto
best = None
for C in [0.3, 1, 3, 10]:
    clf = LogisticRegression(C=C, max_iter=3000, class_weight='balanced')
    clf.fit(Xtr, ytr)
    P = clf.predict_proba(Xva)
    pred = P.argmax(1)
    acc7 = (pred == yva).mean()
    p_ind = P[:, IND]
    # binary task, Indian vs all: pick the threshold with the best balanced accuracy
    ths = np.linspace(0.1, 0.9, 81)
    bal = []
    for th in ths:
        tp = ((p_ind >= th) & (yva == IND)).mean() / (yva == IND).mean()
        tn = ((p_ind < th) & (yva != IND)).mean() / (yva != IND).mean()
        bal.append((tp + tn) / 2)
    i = int(np.argmax(bal)); th = ths[i]
    ind_recall = ((p_ind >= th) & (yva == IND)).sum() / (yva == IND).sum()
    me_fp = ((p_ind >= th) & (yva == ME)).sum() / (yva == ME).sum()
    oth_fp = ((p_ind >= th) & (yva != IND) & (yva != ME)).sum() / ((yva != IND) & (yva != ME)).sum()
    print(f'  C={C}: 7-class acc {acc7:.3f} | Indian-vs-rest thr={th:.2f} bal.acc {bal[i]:.3f} | Indian recall {ind_recall:.3f} | MiddleEast→Indian FP {me_fp:.3f} | others→Indian FP {oth_fp:.3f}')
    if best is None or bal[i] > best['bal']:
        best = dict(C=C, clf=clf, th=float(th), bal=bal[i], acc7=acc7, recall=float(ind_recall), me_fp=float(me_fp), oth_fp=float(oth_fp))

clf = best['clf']
P = clf.predict_proba(Xva)
cm = confusion_matrix(yva, P.argmax(1))
print('confusion (rows=true, cols=pred):')
for r, row in zip(RACES, cm): print(f'  {r:16s}', ' '.join(f'{v:4d}' for v in row))
# share of Middle Eastern faces the 7-class head called Indian, and the other way round
print(f"  ME→Indian {cm[ME, IND] / cm[ME].sum():.3f}, Indian→ME {cm[IND, ME] / cm[IND].sum():.3f}")

# binary head, Indian vs all: calibrated to a 0.5 threshold
ybin = (ytr == IND).astype(int)
bin_best = None
for C in [0.3, 1, 3]:
    cb = LogisticRegression(C=C, max_iter=3000, class_weight='balanced').fit(Xtr, ybin)
    pb = cb.predict_proba(Xva)[:, 1]
    rec = (pb[yva == IND] >= 0.5).mean(); me = (pb[yva == ME] >= 0.5).mean(); oth = (pb[(yva != IND) & (yva != ME)] >= 0.5).mean()
    bal = (rec + 1 - (pb[yva != IND] >= 0.5).mean()) / 2
    print(f'  binary C={C}: @0.5 Indian recall {rec:.3f} | ME→Indian {me:.3f} | others→Indian {oth:.3f} | bal.acc {bal:.3f}')
    if bin_best is None or bal > bin_best[0]: bin_best = (bal, C, cb)
cbin = bin_best[2]
json.dump({
    'backbone': b, 'classes': RACES, 'indian': IND, 'middle_eastern': ME,
    'Wbin': cbin.coef_[0].round(5).tolist(), 'bbin': round(float(cbin.intercept_[0]), 5),
    'W': clf.coef_.round(5).tolist(), 'b': clf.intercept_.round(5).tolist(),
    'threshold': best['th'], 'val': {k: round(float(v), 4) for k, v in best.items() if k in ('bal', 'acc7', 'recall', 'me_fp', 'oth_fp')},
}, open(f'head_{b}.json', 'w'))
print('saved', f'head_{b}.json', 'C=', best['C'])
