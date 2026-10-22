#!/usr/bin/env python3
"""Shared dataset (labels from users who agreed to share) -> training data for the base model.

    IINDU_SHARE_URL=https://iindu-dataset.<account>.workers.dev IINDU_EXPORT_TOKEN=<token> \\
        python3 training/fetch_shared_dataset.py
    python3 training/train_scene.py      # the scene head is retrained with the shared labels (weight SHARED_WEIGHT)

The server (server/) returns only CLIP B/32 embeddings of full frames (float16) and labels, no frames,
so embeddings are not recomputed. Output: training/emb_shared_b32.json.

Junk protection: the server already caps an install at 300 labels a day and validates the format. Here also:
  * at most MAX_PER_INSTALL labels per install (the latest ones), so one eager user does not outweigh everyone;
  * installs where more than half of the labels sharply contradict the current model (20 or more labels, model
    confident the other way: p<0.1 for Indian or p>0.9 for not Indian) are dropped entirely, as likely spam.
    Single labels like that stay: fixing the model's mistakes is why we collect them.
"""
import base64, collections, json, os, sys, urllib.request
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_PER_INSTALL = int(os.environ.get('MAX_PER_INSTALL', 400))


def fetch_all(url, token):
    rows, after = [], 0
    while True:
        req = urllib.request.Request(f'{url}/v1/export?after={after}&limit=5000', headers={'Authorization': f'Bearer {token}'})
        page = json.load(urllib.request.urlopen(req, timeout=60))
        rows += page['items']
        print(f'\r  скачано {len(rows)} меток', end='', flush=True)
        if not page['items'] or page['next'] is None:
            break
        after = page['next']
    print()
    return rows


def main():
    url, token = os.environ.get('IINDU_SHARE_URL', '').rstrip('/'), os.environ.get('IINDU_EXPORT_TOKEN', '')
    if not url or not token:
        print(__doc__); sys.exit(1)
    rows = fetch_all(url, token)
    if not rows:
        print('общий датасет пуст'); return
    X = np.stack([np.frombuffer(base64.b64decode(r['emb']), dtype='<f2').astype(np.float32) for r in rows])
    y = np.array([r['y'] for r in rows])
    head = json.load(open(os.path.join(HERE, '..', 'extension', 'assets', 'model', 'head.json')))
    p = 1 / (1 + np.exp(-(X @ np.array(head['Wscene']) + head['bscene'])))
    clash = ((y == 1) & (p < 0.1)) | ((y == 0) & (p > 0.9))
    by_install = collections.defaultdict(list)
    for i, r in enumerate(rows):
        by_install[r['install']].append(i)
    keep, dropped = [], 0
    for inst, idx in by_install.items():
        if len(idx) >= 20 and clash[idx].mean() > 0.5:
            dropped += 1; continue
        keep += idx[-MAX_PER_INSTALL:]                     # rowid grows over time, so these are the latest
    items = [{'emb': [round(float(v), 5) for v in X[i]], 'label': int(y[i]), 'group': 'shared_' + rows[i]['site'],
              'root': 'shared', 'dtype': rows[i]['dtype']} for i in sorted(keep)]
    out = os.path.join(HERE, 'emb_shared_b32.json')
    json.dump({'items': items}, open(out, 'w'))
    pos = sum(it['label'] for it in items)
    print(f'установок {len(by_install)}, отброшено как накрутка {dropped}; в выборку {len(items)} меток: {pos} индусов, {len(items) - pos} нет')
    print(f'готово: {os.path.relpath(out)}. Дальше: python3 training/train_scene.py')


if __name__ == '__main__':
    main()
