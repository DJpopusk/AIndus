"""Prototype of the final score: zero-shot on the scene plus the trained head on people.
python3 score_proto.py <b32|b16>
"""
import json, sys, numpy as np
b = sys.argv[1]
W0, W1 = (float(sys.argv[2]), float(sys.argv[3])) if len(sys.argv) > 3 else (0.3, 0.5)
P = json.load(open(f'prompts_{b}.json'))['sets']
H = json.load(open(f'head_{b}.json'))
W, B = np.array(H['W']), np.array(H['b']); IND, ME = H['indian'], H['middle_eastern']
WB, BB = np.array(H['Wbin']), H['bbin']
T = {k: np.array(v['emb']) for k, v in P.items()}
LABELS = P['context']['labels'] + P['person']['labels'] + P['negative']['labels']
NPOS = len(P['context']['labels']) + len(P['person']['labels'])
TZS = np.vstack([T['context'], T['person'], T['negative']])

def softmax(z):
    z = z - z.max(-1, keepdims=True); e = np.exp(z); return e / e.sum(-1, keepdims=True)

def components(emb, emb_top=None, emb_center=None):
    e = np.array(emb)
    p = softmax(100 * TZS @ e)
    zs = p[:NPOS].sum(); top = LABELS[int(p.argmax())]
    g = softmax(100 * T['gate'] @ e)
    p_close, p_people = g[0], g[0] + g[1]
    crops = [e] + [np.array(c) for c in (emb_top, emb_center) if c is not None]
    probs = [softmax(W @ c + B) for c in crops]
    p_ind = max(1 / (1 + np.exp(-(WB @ c + BB))) for c in crops)
    p_me = max(pr[ME] for pr in probs)
    return dict(zs=zs, top=top, p_close=p_close, p_people=p_people, p_ind=p_ind, p_me=p_me)

def final(c):
    # the trained head's weight grows with how much of a person the frame shows; with no people only the scene counts
    w = W0 + W1 * c['p_close']
    return (1 - w) * c['zs'] + w * c['p_ind']

# 1) Commons set (scenes)
d = json.load(open(f'emb_commons_{b}.json'))
rows = []
for it in d['items']:
    c = components(it['emb'], it.get('emb_top'), it.get('emb_center'))
    rows.append((it['kind'], it['query'][:26], c, final(c)))
rows.sort(key=lambda r: (r[0], -r[3]))
print(f'== Commons ({b})  kind  name                        zs   people close  P(ind) P(ME)  FINAL')
for k, n, c, f in rows:
    flag = '  <-- ошибка' if (k == 'pos') != (f >= 0.5) else ''
    print(f'   {k:4s} {n:26s} {c["zs"]:.2f}  {c["p_people"]:.2f}  {c["p_close"]:.2f}  {c["p_ind"]:.2f}  {c["p_me"]:.2f}  {f:.2f}{flag}')
pos = [f for k, _, _, f in rows if k == 'pos']; neg = [f for k, _, _, f in rows if k == 'neg']
print(f'   accuracy@0.5: {(sum(f>=0.5 for f in pos)+sum(f<0.5 for f in neg))/len(rows):.2f}  (pos min {min(pos):.2f}, neg max {max(neg):.2f})')

# 2) FairFace val (faces): plain zero-shot against the final formula
d = json.load(open(f'emb_ff_val_{b}.json'))
y = np.array([it['race'] for it in d['items']])
zs = np.array([components(it['emb'])['zs'] for it in d['items']])
fin = np.array([final(components(it['emb'])) for it in d['items']])
for name, s in (('zero-shot', zs), ('final', fin)):
    ind_rec = (s[y == IND] >= 0.5).mean(); me_fp = (s[y == ME] >= 0.5).mean(); oth_fp = (s[(y != IND) & (y != ME)] >= 0.5).mean()
    print(f'== FairFace val ({b}) {name:9s}: Indian recall {ind_rec:.3f} | Middle Eastern → "индус" {me_fp:.3f} | остальные → "индус" {oth_fp:.3f}')
