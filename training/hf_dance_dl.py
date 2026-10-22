"""Extra scenes from Hugging Face (datasets-server, without the Commons limits):
  Indian classical dances (label 1) and DanceTrack, modern group dances (label 0).
python3 hf_dance_dl.py -> hfdance/manifest.json + hfdance/img/
"""
import json, os, random, time, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor

UA = {"User-Agent": "aindu-training/0.1"}
OUT = "hfdance"; os.makedirs(f"{OUT}/img", exist_ok=True)
random.seed(5)
SOURCES = [  # (dataset, split, total rows, how many to take, label, group)
    ("tanmaykm/indian_dance_forms", "train", 1190, 320, 1, "hf_ind_dance"),
    ("AIMLOps-C4-G16/indian_classical_dances", "train", 1383, 220, 1, "hf_ind_dance"),
    ("noahcao/dancetrack", "train", 41876, 300, 0, "hf_dancetrack"),
    ("cadenlpicard/dance_images", "train", 916, 120, None, "hf_dance_images"),  # the label is set after a look at the images
]

def rows(ds, split, offset, length):
    url = "https://datasets-server.huggingface.co/rows?" + urllib.parse.urlencode({"dataset": ds, "config": "default", "split": split, "offset": offset, "length": length})
    for attempt in range(5):
        try:
            d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90))
            return [(r["row_idx"], r["row"]["image"]["src"]) for r in d["rows"] if r["row"].get("image")]
        except Exception as e:
            print("retry", ds, offset, e); time.sleep(3 + attempt * 5)
    return []

def dl(args):
    fn, src = args
    if os.path.exists(fn) and os.path.getsize(fn) > 0: return True
    for attempt in range(3):
        try:
            open(fn, "wb").write(urllib.request.urlopen(urllib.request.Request(src, headers=UA), timeout=90).read()); return True
        except Exception:
            time.sleep(1 + attempt)
    return False

items = []
for ds, split, total, want, label, group in SOURCES:
    picked = []
    # DanceTrack frames come in video order, so take 2 frames from many random places to avoid near-duplicates
    per_call = 2 if "dancetrack" in ds else 25
    offsets = random.sample(range(0, total - per_call), min(want // per_call + 2, (total - per_call) // per_call))
    for off in offsets:
        got = rows(ds, split, off, per_call)
        picked += got
        if len(picked) >= want: break
        time.sleep(0.3)
    picked = picked[:want]
    jobs = [(f"{OUT}/img/{group}_{ds.split('/')[-1][:12]}_{idx}.jpg", src) for idx, src in picked]
    with ThreadPoolExecutor(6) as ex: ok = list(ex.map(dl, jobs))
    for (fn, src), o in zip(jobs, ok):
        if o: items.append({"file": fn, "label": label, "group": group, "root": ds})
    print(ds, "→", sum(ok), "images", flush=True)
json.dump({"items": items}, open(f"{OUT}/manifest.json", "w"))
print("done", len(items))
