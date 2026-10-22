import json, numpy as np, warnings; warnings.filterwarnings('ignore')
d=json.load(open('emb_scene_b32.json'))['items']
P=json.load(open('prompts_b32.json'))['sets']; H=json.load(open('head_b32.json'))
T={k:np.array(v['emb']) for k,v in P.items()}
TZS=np.vstack([T['context'],T['person'],T['negative']]); NPOS=len(P['context']['labels'])+len(P['person']['labels'])
WB,BB=np.array(H['Wbin']),H['bbin']; W7,B7=np.array(H['W']),np.array(H['b']); WS,BS=np.array(H['Wscene']),H['bscene']
def softmax(z): z=z-z.max(-1,keepdims=True); e=np.exp(z); return e/e.sum(-1,keepdims=True)
sig=lambda x:1/(1+np.exp(-x))
for grp in ['georgian','caucasus','slavic','turkish','ind_dance','hf_ind_dance']:
    its=[it for it in d if it['group']==grp]
    X=np.array([it['emb'] for it in its]); Xt=np.array([it['emb_top'] for it in its]); Xc=np.array([it['emb_center'] for it in its])
    zs=softmax(100*X@TZS.T)[:,:NPOS].sum(1); close=softmax(100*X@T['gate'].T)[:,0]
    pf=np.max([sig(X@WB+BB),sig(Xt@WB+BB),sig(Xc@WB+BB)],axis=0)
    best=np.argmax([sig(X@WB+BB),sig(Xt@WB+BB),sig(Xc@WB+BB)],axis=0)
    Xb=np.where((best==0)[:,None],X,np.where((best==1)[:,None],Xt,Xc))
    p7=softmax(Xb@W7.T+B7); guess=p7.argmax(1)
    ps=sig(X@WS+BS); w=0.3+0.5*close
    fin=(1-w)*(0.5*zs+0.5*ps)+w*pf
    names=H['classes']
    from collections import Counter
    print(f"{grp:12s} n={len(its):3d} | zs {zs.mean():.2f} | scene-head {ps.mean():.2f} | face P(ind) mean {pf.mean():.2f}, ≥0.5: {(pf>=0.5).mean():.2f} | closeup mean {close.mean():.2f} | final ≥0.5: {(fin>=0.5).mean():.2f} ≥0.6: {(fin>=0.6).mean():.2f} | 7-class guess: {dict(Counter(names[g] for g in guess).most_common(4))}")
