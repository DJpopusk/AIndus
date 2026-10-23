#!/usr/bin/env python3
"""Builds the list of authors and licences from the asset manifests:
    python3 scripts/make-credits.py   -> extension/credits.html (opened from the popup) and CREDITS.md

Sources: assets/models/people/people.json (people, stars, gods, cows, animals, dogs, vehicles), assets/songs/songs.json,
assets/backdrops/backdrops.json, plus the libraries and training data listed below.
pack.sh runs it before packing, so the list always matches what is in the archive.
"""
import html, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, 'extension')
LIC_URL = {
    'CC BY 4.0': 'https://creativecommons.org/licenses/by/4.0/', 'CC BY 3.0': 'https://creativecommons.org/licenses/by/3.0/',
    'CC BY-SA 4.0': 'https://creativecommons.org/licenses/by-sa/4.0/', 'CC BY-SA 3.0': 'https://creativecommons.org/licenses/by-sa/3.0/',
    'CC BY-NC 4.0': 'https://creativecommons.org/licenses/by-nc/4.0/', 'CC0': 'https://creativecommons.org/publicdomain/zero/1.0/',
    'Sketchfab Free Standard': 'https://sketchfab.com/licenses', 'by 2.0': 'https://creativecommons.org/licenses/by/2.0/',
    'by-sa 2.0': 'https://creativecommons.org/licenses/by-sa/2.0/', 'by 4.0': 'https://creativecommons.org/licenses/by/4.0/',
}
KIND = {'m': 'Танцоры', 'f': 'Танцоры', 'god': 'Боги', 'cow': 'Коровы', 'animal': 'Животные', 'vehicle': 'Транспорт', 'dog': 'Собаки'}
LIBS = [
    ('three.js', 'three.js authors', 'MIT', 'https://github.com/mrdoob/three.js'),
    ('meshoptimizer (декодер)', 'Arseny Kapoulkine', 'MIT', 'https://github.com/zeux/meshoptimizer'),
    ('Transformers.js', 'Hugging Face', 'Apache-2.0', 'https://github.com/huggingface/transformers.js'),
    ('ONNX Runtime Web', 'Microsoft', 'MIT', 'https://github.com/microsoft/onnxruntime'),
    ('CLIP ViT-B/32 (веса Xenova/clip-vit-base-patch32)', 'OpenAI', 'MIT', 'https://huggingface.co/Xenova/clip-vit-base-patch32'),
    ('FairFace (обучение головы по лицам)', 'Kärkkäinen, Joo', 'CC BY 4.0', 'https://github.com/joojs/fairface'),
    ('AIST++ (уличные танцы: хип-хоп, локинг, поппинг, крамп, хаус, джаз, брейк; из аннотаций взяты повороты суставов, перенесены на свой скелет и зациклены)',
     'Google LLC; танцоры AIST Dance Video Database', 'CC BY 4.0', 'https://google.github.io/aistplusplus_dataset/'),
    ('100STYLE (смешные стили движения: курица, зомби, динозавр, чайник и др.; записи обрезаны, развёрнуты к камере и зациклены)',
     'Ian Mason, Sebastian Starke, Taku Komura', 'CC BY 4.0', 'https://www.ianxmason.com/100style/'),
    ('CMU Graphics Lab Motion Capture Database (индийский танец — субъект 94, русская плясовая — субъект 90, пантомимы — субъект 55). The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.',
     'Carnegie Mellon University', 'можно включать в продукты, нельзя перепродавать сами данные', 'http://mocap.cs.cmu.edu/'),
]


def lic_link(lic):
    u = LIC_URL.get(lic) or LIC_URL.get((lic or '').lower())
    return f'<a href="{u}">{html.escape(lic)}</a>' if u else html.escape(lic or '?')


def main():
    people = json.load(open(os.path.join(EXT, 'assets/models/people/people.json')))
    songs = json.load(open(os.path.join(EXT, 'assets/songs/songs.json')))
    bds = json.load(open(os.path.join(EXT, 'assets/backdrops/backdrops.json')))
    groups = {}
    for p in people:
        groups.setdefault(KIND.get(p['kind'], 'Прочее'), []).append(p)
    md = ['# Авторы и лицензии', '', 'Всё, что лежит в расширении, и откуда оно взято. Список собирается скриптом `scripts/make-credits.py`.', '']
    h = []
    for title in ['Танцоры', 'Боги', 'Коровы', 'Животные', 'Собаки', 'Транспорт', 'Прочее']:
        rows = groups.get(title, [])
        if not rows: continue
        md += [f'## 3D-модели: {title.lower()}', '', '| Модель | Автор | Лицензия |', '|---|---|---|']
        h.append(f'<h2>3D-модели: {title.lower()}</h2><table><tr><th>Модель</th><th>Автор</th><th>Лицензия</th></tr>')
        for p in rows:
            name = p.get('title') or p['name']
            md.append(f"| [{name}]({p['source']}) | [{p['author']}]({p.get('author_url') or p['source']}) | {p['license']} |")
            h.append(f"<tr><td><a href=\"{p['source']}\">{html.escape(name)}</a></td><td><a href=\"{p.get('author_url') or p['source']}\">{html.escape(p['author'])}</a></td><td>{lic_link(p['license'])}</td></tr>")
        md.append(''); h.append('</table>')
    md += ['Модели сжаты (meshopt, WebP) и перекрашены; танцы перенесены на их скелеты. Это изменения в смысле CC BY: оригиналы — по ссылкам.', '',
           '## Фотографии фона', '', '| Место | Автор | Лицензия |', '|---|---|---|']
    h.append('<p class="note">Модели сжаты (meshopt, WebP) и перекрашены; танцы перенесены на их скелеты. Это изменения в смысле CC BY: оригиналы — по ссылкам.</p>')
    h.append('<h2>Фотографии фона</h2><table><tr><th>Место</th><th>Автор</th><th>Лицензия</th></tr>')
    for b in bds:
        lic = b['license'].upper().replace('BY-SA', 'BY-SA').replace('BY ', 'BY ')
        md.append(f"| [{b['place']}]({b['source']}) | {b['author']} | CC {lic} |")
        h.append(f"<tr><td><a href=\"{b['source']}\">{html.escape(b['place'])}</a></td><td>{html.escape(b['author'] or '?')}</td><td>{lic_link(b['license'])}</td></tr>")
    md.append(''); h.append('</table>')
    md += ['## Музыка', '', '| Трек | Лицензия | Источник |', '|---|---|---|']
    h.append('<h2>Музыка</h2><table><tr><th>Трек</th><th>Лицензия</th><th>Источник</th></tr>')
    for s in songs:
        if s.get('private'): continue                  # the user's own tracks never go into the archive
        md.append(f"| {s['title']} | {s.get('license', '?')} | {s.get('source', '')} |")
        src = s.get('source', '')
        h.append(f"<tr><td>{html.escape(s['title'])}</td><td>{html.escape(s.get('license', '?'))}</td><td>{f'<a href=\"{src}\">ссылка</a>' if src.startswith('http') else html.escape(src)}</td></tr>")
    md.append(''); h.append('</table>')
    md += ['## Библиотеки, модель и данные', '', '| Что | Автор | Лицензия |', '|---|---|---|']
    h.append('<h2>Библиотеки, модель и данные</h2><table><tr><th>Что</th><th>Автор</th><th>Лицензия</th></tr>')
    for name, author, lic, url in LIBS:
        md.append(f'| [{name}]({url}) | {author} | {lic} |')
        h.append(f'<tr><td><a href="{url}">{html.escape(name)}</a></td><td>{html.escape(author)}</td><td>{html.escape(lic)}</td></tr>')
    md.append(''); h.append('</table>')
    open(os.path.join(ROOT, 'CREDITS.md'), 'w').write('\n'.join(md) + '\n')
    page = f"""<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>AIndus: авторы</title>
<style>body{{font:14px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#222;background:#fff}}
h1{{font-size:24px}}h2{{font-size:18px;margin-top:28px}}table{{border-collapse:collapse;width:100%}}td,th{{border-bottom:1px solid #e5e5e5;padding:6px 8px;text-align:left;vertical-align:top}}
th{{font-weight:600;color:#555}}a{{color:#c25e00}}.note{{color:#666;font-size:13px}}
@media (prefers-color-scheme: dark){{body{{background:#161311;color:#eee}}td,th{{border-color:#333}}th{{color:#aaa}}a{{color:#ffb366}}.note{{color:#999}}}}</style></head>
<body><h1>Авторы и лицензии</h1><p class="note">Всё, что лежит в расширении AIndus, и откуда оно взято.</p>{''.join(h)}</body></html>"""
    open(os.path.join(EXT, 'credits.html'), 'w').write(page)
    print('CREDITS.md и extension/credits.html:', len(people), 'моделей,', len(bds), 'фото,', sum(1 for s in songs if not s.get('private')), 'треков')


if __name__ == '__main__':
    main()
