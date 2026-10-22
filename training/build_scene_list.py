"""Builds one list of scenes to embed from all sources:
  openverse/manifest.json, hfdance/manifest.json, commons/manifest.json (if present), calib_manifest.json (the old set).
python3 build_scene_list.py -> scene_list.json
"""
import json, os
items = []
for mf in ("openverse/manifest.json", "openverse_lifestyle/manifest.json", "hfdance/manifest.json", "hfgeneric/manifest.json", "commons/manifest.json"):
    if os.path.exists(mf):
        for it in json.load(open(mf))["items"]:
            if it.get("label") is None or not os.path.exists(it["file"]) or os.path.getsize(it["file"]) < 8000: continue
            items.append({"file": it["file"], "label": it["label"], "group": it["group"], "root": it.get("root", mf)})
if os.path.exists("calib_manifest.json"):
    for it in json.load(open("calib_manifest.json")):
        f = "calib_img/" + os.path.basename(it["file"])
        if os.path.exists(f):
            items.append({"file": f, "label": 1 if it["kind"] == "pos" else 0, "group": "calib_" + it["kind"], "root": "calib:" + it["query"]})
json.dump(items, open("scene_list.json", "w"), ensure_ascii=False)
from collections import Counter
c = Counter((it["label"], it["group"]) for it in items)
print(len(items), "images;", "pos", sum(v for (l, g), v in c.items() if l == 1), "neg", sum(v for (l, g), v in c.items() if l == 0))
for (l, g), v in sorted(c.items()): print(f"  label {l} {g:16s} {v}")
