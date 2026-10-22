import json, sys, numpy as np, warnings
warnings.filterwarnings('ignore')
from sklearn.neural_network import MLPClassifier
from sklearn.linear_model import LogisticRegression
b = sys.argv[1]; IND, ME = 1, 4
def load(f):
    d = json.load(open(f)); return np.array([it['emb'] for it in d['items']], dtype=np.float32), np.array([it['race'] for it in d['items']])
Xtr, ytr = load(f'emb_ff_train_{b}.json'); Xva, yva = load(f'emb_ff_val_{b}.json')
ybin = (ytr == IND).astype(int)
def report(name, p):
    rec = (p[yva == IND] >= 0.5).mean(); me = (p[yva == ME] >= 0.5).mean(); oth = (p[(yva != IND) & (yva != ME)] >= 0.5).mean()
    bal = (rec + 1 - (p[yva != IND] >= 0.5).mean()) / 2
    print(f'{b} {name:28s} recall {rec:.3f} | ME→Indian {me:.3f} | others→Indian {oth:.3f} | bal.acc {bal:.3f}')
# class balancing through sample weights for the MLP (it has no class_weight)
w = np.where(ybin == 1, 0.5 / ybin.mean(), 0.5 / (1 - ybin.mean()))
idx = np.random.default_rng(0).choice(len(Xtr), size=len(Xtr) * 2, p=w / w.sum())
for h, alpha in [((256,), 1e-3), ((512, 128), 1e-3), ((256,), 1e-2)]:
    m = MLPClassifier(hidden_layer_sizes=h, alpha=alpha, max_iter=300, early_stopping=True, random_state=0).fit(Xtr[idx], ybin[idx])
    report(f'MLP {h} a={alpha}', m.predict_proba(Xva)[:, 1])
report('logreg C=1', LogisticRegression(C=1, max_iter=3000, class_weight='balanced').fit(Xtr, ybin).predict_proba(Xva)[:, 1])
