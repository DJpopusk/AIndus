"""Downloads a balanced FairFace sample (padding 1.25) through the Hugging Face datasets-server API."""
import json, os, random, time, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor

UA = {"User-Agent": "aindu-calib/0.1"}
DS = "HuggingFaceM4/FairFace"
RACES = ['East Asian', 'Indian', 'Black', 'White', 'Middle Eastern', 'Latino_Hispanic', 'Southeast Asian']
OUT = "fairface"
os.makedirs(f"{OUT}/train", exist_ok=True); os.makedirs(f"{OUT}/val", exist_ok=True)
random.seed(7)

def rows(split, offset, length=100):
    url = "https://datasets-server.huggingface.co/rows?" + urllib.parse.urlencode({"dataset": DS, "config": "1.25", "split": split, "offset": offset, "length": length})
    for attempt in range(5):
        try:
            d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60))
            return [(r["row_idx"], r["row"]["image"]["src"], r["row"]["race"], r["row"]["gender"], r["row"]["age"]) for r in d["rows"]]
        except Exception as e:
            time.sleep(2 + attempt * 3)
    return []

def collect(split, total, n_calls, quota):
    got = {r: [] for r in range(7)}
    offsets = random.sample(range(0, total - 100, 100), n_calls)
    for i, off in enumerate(offsets):
        for idx, src, race, gender, age in rows(split, off):
            if len(got[race]) < quota[race]:
                got[race].append({"idx": idx, "src": src, "race": race, "gender": gender, "age": age})
        done = sum(len(v) for v in got.values())
        print(f"{split}: call {i+1}/{n_calls}", {RACES[r][:6]: len(v) for r, v in got.items()}, flush=True)
        if all(len(got[r]) >= quota[r] for r in range(7)): break
        time.sleep(0.25)
    return [x for v in got.values() for x in v]

# train: more Indian and Middle Eastern faces (the key pair), fewer of the others
train_quota = {0: 300, 1: 1100, 2: 300, 3: 400, 4: 1100, 5: 350, 6: 300}
val_quota = {0: 120, 1: 300, 2: 120, 3: 150, 4: 300, 5: 120, 6: 120}
train = collect("train", 86744, 90, train_quota)
val = collect("validation", 10954, 40, val_quota)

def dl(item, split):
    fn = f"{OUT}/{split}/{item['idx']}.jpg"
    item["file"] = fn
    if os.path.exists(fn) and os.path.getsize(fn) > 0: return True
    for attempt in range(3):
        try:
            data = urllib.request.urlopen(urllib.request.Request(item["src"], headers=UA), timeout=60).read()
            open(fn, "wb").write(data); return True
        except Exception:
            time.sleep(1 + attempt)
    return False

for split, items in (("train", train), ("val", val)):
    with ThreadPoolExecutor(8) as ex:
        ok = list(ex.map(lambda it: dl(it, split), items))
    items[:] = [it for it, o in zip(items, ok) if o]
    print(split, "downloaded", len(items), flush=True)
json.dump({"races": RACES, "train": train, "val": val}, open(f"{OUT}/manifest.json", "w"))
print("done")
