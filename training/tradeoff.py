import json, sys, numpy as np, warnings; warnings.filterwarnings('ignore')
from sklearn.metrics import roc_auc_score
b = sys.argv[1]; IND, ME = 1, 4
P = json.load(open(f'prompts_{b}.json'))['sets']; H = json.load(open(f'head_{b}.json'))
T = {k: np.array(v['emb']) for k, v in P.items()}
TZS = np.vstack([T['context'], T['person'], T['negative']]); NPOS = len(P['context']['labels']) + len(P['person']['labels'])
W, B, WB, BB = np.array(H['W']), np.array(H['b']), np.array(H['Wbin']), H['bbin']
def softmax(z): z = z - z.max(-1, keepdims=True); e = np.exp(z); return e / e.sum(-1, keepdims=True)
d = json.load(open(f'emb_ff_val_{b}.json'))['items']
X = np.array([it['emb'] for it in d]); y = np.array([it['race'] for it in d])
pz = softmax(100 * X @ TZS.T); zs = pz[:, :NPOS].sum(1)
pg = softmax(100 * X @ T['gate'].T); close = pg[:, 0]
pbin = 1 / (1 + np.exp(-(X @ WB + BB)))
p7 = softmax(X @ W.T + B)
w = 0.3 + 0.5 * close
blend = (1 - w) * zs + w * pbin
# veto: if the 7-class head is sure this is not Indian (max over the other classes > 0.5), halve the score
other_conf = np.delete(p7, IND, axis=1).max(1)
veto = blend * np.where(other_conf > 0.5, 0.5, 1.0)
ybin = (y == IND).astype(int)
for name, s in [('zero-shot v2', zs), ('binary head', pbin), ('blend', blend), ('blend+veto', veto)]:
    print(f'{b} {name:13s} AUC {roc_auc_score(ybin, s):.3f} |', ' '.join(f'thr{t:.2f}: rec {(s[y==IND]>=t).mean():.2f}/ME {(s[y==ME]>=t).mean():.2f}/oth {(s[(y!=IND)&(y!=ME)]>=t).mean():.2f}' for t in (0.4, 0.5, 0.6, 0.7)))
