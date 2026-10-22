"""Generic scenes from Hugging Face (datasets-server): Flickr30k and COCO as everyday negatives (label 0),
Indian cities and Indian professions as positives (label 1). python3 hf_generic_dl.py -> hfgeneric/manifest.json
"""
import json, os, random, time, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor

UA = {"User-Agent": "aindu-training/0.1"}
OUT = "hfgeneric"; os.makedirs(f"{OUT}/img", exist_ok=True)
random.seed(9)
# (dataset, config, split, total rows, take, label, group, rows per call)
SOURCES = [
    ("nlphuji/flickr30k", "TEST", "test", 31014, 600, 0, "flickr30k", 20),
    ("detection-datasets/coco", "default", "val", 4952, 300, 0, "coco", 20),
    ("diabolic6045/Images-of-Top-Indian-Cities", "default", "train", None, 160, 1, "ind_city", 10),
    ("NYUAD-ComNets/Indian_Female_Profession", "default", "train", None, 100, 1, "ind_prof", 10),
    ("NYUAD-ComNets/Indian_Male_Profession", "default", "train", None, 100, 1, "ind_prof", 10),
]

def api(url):
    for attempt in range(4):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120))
        except Exception as e:
            print("  retry", str(e)[:80]); time.sleep(3 + attempt * 5)
    return {}

def total_rows(ds, cfg, split):
    d = api("https://datasets-server.huggingface.co/info?" + urllib.parse.urlencode({"dataset": ds, "config": cfg}))
    try: return d["dataset_info"]["splits"][split]["num_examples"]
    except Exception: return None

def rows(ds, cfg, split, offset, length):
    d = api("https://datasets-server.huggingface.co/rows?" + urllib.parse.urlencode({"dataset": ds, "config": cfg, "split": split, "offset": offset, "length": length}))
    out = []
    for r in d.get("rows", []):
        row = r["row"]
        img = row.get("image") or next((v for v in row.values() if isinstance(v, dict) and v.get("src")), None)
        if img and img.get("src"): out.append((r["row_idx"], img["src"]))
    return out

def dl(args):
    fn, src = args
    if os.path.exists(fn) and os.path.getsize(fn) > 0: return True
    for attempt in range(3):
        try: open(fn, "wb").write(urllib.request.urlopen(urllib.request.Request(src, headers=UA), timeout=120).read()); return True
        except Exception: time.sleep(1 + attempt)
    return False

items = []
for ds, cfg, split, total, want, label, group, per in SOURCES:
    total = total or total_rows(ds, cfg, split)
    if not total: print(ds, "нет info, пропускаю"); continue
    picked = []
    for off in random.sample(range(0, max(1, total - per)), min(want // per + 3, max(1, (total - per) // per))):
        picked += rows(ds, cfg, split, off, per)
        if len(picked) >= want: break
        time.sleep(0.2)
    picked = picked[:want]
    jobs = [(f"{OUT}/img/{group}_{ds.split('/')[-1][:14]}_{idx}.jpg", src) for idx, src in picked]
    with ThreadPoolExecutor(6) as ex: ok = list(ex.map(dl, jobs))
    for (fn, _), o in zip(jobs, ok):
        if o and os.path.getsize(fn) > 5000: items.append({"file": fn, "label": label, "group": group, "root": "hf:" + ds})
    print(f"{ds} ({total} rows) → {sum(ok)} images", flush=True)
    json.dump({"items": items}, open(f"{OUT}/manifest.json", "w"))
print("done", len(items))
