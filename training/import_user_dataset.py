#!/usr/bin/env python3
"""Dataset from users' fine-tuning -> training data for the base model.

    python3 training/import_user_dataset.py ~/Downloads/aindus-dataset-*.zip
    python3 training/train_scene.py          # the scene head is retrained with these frames

Each zip from the popup (dataset download) is unpacked into training/user_data/<name>/. Frames are deduplicated by
content (the same reel may have been labelled twice or appear in several archives), all of them are embedded with
the same CLIP B/32 (embed.mjs), and the result goes to training/emb_user_b32.json.
train_scene.py mixes these frames in with weight USER_WEIGHT (2 by default): labels from a real feed are closer to
what the model sees in use than stock photos.
"""
import csv, hashlib, io, json, os, subprocess, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, 'user_data')


def main(paths):
    if not paths:
        print(__doc__); sys.exit(1)
    os.makedirs(OUT_DIR, exist_ok=True)
    seen, items = set(), []
    # frames imported earlier go into the set too (the script can be run again with new archives)
    for zpath in paths:
        name = os.path.splitext(os.path.basename(zpath))[0]
        with zipfile.ZipFile(zpath) as z:
            rows = list(csv.DictReader(io.TextIOWrapper(z.open('labels.csv'), encoding='utf-8')))
            for r in rows:
                data = z.read(r['file'])
                h = hashlib.sha1(data).hexdigest()[:16]
                dst = os.path.join(OUT_DIR, f'{h}.jpg')
                if not os.path.exists(dst):
                    open(dst, 'wb').write(data)
                if h in seen:
                    continue
                seen.add(h)
                items.append({'file': os.path.relpath(dst, HERE), 'label': int(r['label']), 'group': 'user_' + (r.get('site') or 'other'),
                              'root': 'user:' + name, 'url': r.get('url', ''), 'score_then': float(r['score'] or 0)})
        print(f'{zpath}: {len(rows)} строк')
    old = os.path.join(HERE, 'user_list.json')
    if os.path.exists(old):
        for it in json.load(open(old)):
            h = os.path.splitext(os.path.basename(it['file']))[0]
            if h not in seen and os.path.exists(os.path.join(HERE, it['file'])):
                seen.add(h); items.append(it)
    json.dump(items, open(old, 'w'), ensure_ascii=False, indent=1)
    pos = sum(it['label'] for it in items)
    print(f'итого {len(items)} уникальных кадров: {pos} индусов, {len(items) - pos} нет → считаю эмбеддинги…')
    subprocess.run(['node', 'embed.mjs', 'b32', 'user_list.json', 'emb_user_b32.json', '--crops'], cwd=HERE, check=True)
    print('готово: training/emb_user_b32.json. Дальше: python3 training/train_scene.py')


if __name__ == '__main__':
    main(sys.argv[1:])
