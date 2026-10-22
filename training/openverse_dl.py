"""Scenes through Openverse (CC photos, mostly Flickr): Indian dances, weddings and streets (label 1)
against Georgian, Caucasian, Slavic, Turkish, Middle Eastern, Latin, Asian and modern dances,
other weddings and streets (label 0). Anonymous API limit: 20 requests a minute, 200 a day.
python3 openverse_dl.py -> openverse/manifest.json + openverse/img/
"""
import json, os, re, time, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor

UA = {"User-Agent": "aindu-training/0.1 (personal meme project)"}
import sys
SET = sys.argv[1] if len(sys.argv) > 1 else "dance"
OUT = "openverse" if SET == "dance" else f"openverse_{SET}"; os.makedirs(f"{OUT}/img", exist_ok=True)
PAGES_DEFAULT = 2
# (query, label, group, pages)
QUERIES = [
    # Indian = 1
    ("bhangra dance", 1, "ind_dance", 2), ("garba dance navratri", 1, "ind_dance", 2), ("bollywood dance", 1, "ind_dance", 2), ("kathak dance", 1, "ind_dance", 2),
    ("bharatanatyam dance", 1, "ind_dance", 2), ("odissi dance", 1, "ind_dance", 1), ("rajasthani folk dance", 1, "ind_dance", 2), ("kerala folk dance", 1, "ind_dance", 1),
    ("indian classical dance performance", 1, "ind_dance", 2), ("indian wedding dance", 1, "ind_wedding", 2), ("indian wedding baraat", 1, "ind_wedding", 2), ("punjabi wedding", 1, "ind_wedding", 2),
    ("holi festival india", 1, "ind_festival", 2), ("diwali celebration india", 1, "ind_festival", 2), ("durga puja kolkata", 1, "ind_festival", 1), ("ganesh festival mumbai", 1, "ind_festival", 1),
    ("indian street market", 1, "ind_street", 2), ("mumbai street people", 1, "ind_street", 1), ("delhi street crowd", 1, "ind_street", 1), ("indian family portrait", 1, "ind_people", 1),
    # Georgian / Caucasian = 0
    ("georgian folk dance", 0, "georgian", 3), ("lezginka", 0, "georgian", 3), ("georgian dance", 0, "georgian", 3), ("georgian national ballet sukhishvili", 0, "georgian", 2),
    ("kartuli dance georgia", 0, "georgian", 2), ("adjarian dance", 0, "georgian", 1), ("caucasus dance", 0, "georgian", 2), ("georgian wedding", 0, "georgian", 2), ("tbilisi street people", 0, "georgian", 1),
    ("armenian folk dance", 0, "caucasus", 2), ("azerbaijani folk dance", 0, "caucasus", 2), ("ossetian dance", 0, "caucasus", 1), ("dagestan dance", 0, "caucasus", 1), ("chechen dance", 0, "caucasus", 1),
    # Slavic = 0
    ("russian folk dance", 0, "slavic", 2), ("ukrainian folk dance hopak", 0, "slavic", 2), ("cossack dance", 0, "slavic", 1), ("polish folk dance", 0, "slavic", 1),
    ("hungarian folk dance", 0, "slavic", 1), ("bulgarian folk dance", 0, "slavic", 1), ("serbian kolo dance", 0, "slavic", 1), ("russian wedding", 0, "slavic", 1), ("moscow street people", 0, "slavic", 1),
    # Turkish / Middle Eastern / Central Asian = 0
    ("turkish folk dance", 0, "turkish", 2), ("halay dance", 0, "turkish", 1), ("turkish wedding", 0, "turkish", 1), ("istanbul street people", 0, "turkish", 1),
    ("dabke dance", 0, "mideast", 2), ("belly dance", 0, "mideast", 1), ("persian dance", 0, "mideast", 1), ("arab wedding", 0, "mideast", 1),
    ("uzbek dance", 0, "casia", 1), ("kazakh dance", 0, "casia", 1),
    # Europe / Latin America / Africa / Asia / modern = 0
    ("greek folk dance", 0, "europe", 1), ("flamenco dancer", 0, "europe", 1), ("irish dance", 0, "europe", 1), ("folk dance festival europe", 0, "europe", 2),
    ("tango dance", 0, "latam", 1), ("salsa dancing", 0, "latam", 1), ("samba carnival", 0, "latam", 1), ("african dance", 0, "africa", 1),
    ("chinese folk dance", 0, "asia", 1), ("korean traditional dance", 0, "asia", 1), ("balinese dance", 0, "asia", 1), ("thai dance", 0, "asia", 1),
    ("ballet performance", 0, "modern", 1), ("hip hop dance", 0, "modern", 1), ("breakdance", 0, "modern", 1), ("kpop dance", 0, "modern", 1), ("wedding dance", 0, "modern", 1),
]

# everyday scenes: ordinary lifestyle content, common in reels and missing from the first set
LIFESTYLE = [
    # Indian lifestyle (not dance) = 1
    ("indian family", 1, "ind_life", 2), ("indian mother daughter", 1, "ind_life", 1), ("indian girl portrait", 1, "ind_life", 1), ("indian couple", 1, "ind_life", 1),
    ("indian friends cafe", 1, "ind_life", 1), ("indian woman kurta", 1, "ind_life", 1), ("indian man selfie", 1, "ind_life", 1), ("delhi metro people", 1, "ind_life", 1),
    ("kerala family", 1, "ind_life", 1), ("indian office workers", 1, "ind_life", 1), ("indian students college", 1, "ind_life", 1), ("indian kids playing", 1, "ind_life", 1),
    ("indian grandmother", 1, "ind_life", 1), ("indian woman garden", 1, "ind_life", 1), ("punjabi family", 1, "ind_life", 1), ("indian tourists", 1, "ind_life", 1),
    ("bangalore people street", 1, "ind_life", 1), ("indian village people", 1, "ind_life", 1), ("indian woman cooking kitchen", 1, "ind_life", 1), ("indian baby mother", 1, "ind_life", 1),
    # everyday scenes of other peoples = 0 (Caucasus and Middle East kept separate)
    ("armenian family", 0, "cauc_life", 2), ("armenian girl", 0, "cauc_life", 1), ("yerevan street people", 0, "cauc_life", 1), ("georgian family", 0, "cauc_life", 1),
    ("tbilisi cafe people", 0, "cauc_life", 1), ("azerbaijan family", 0, "cauc_life", 1), ("caucasus people portrait", 0, "cauc_life", 1),
    ("turkish family", 0, "me_life", 1), ("iranian family", 0, "me_life", 1), ("arab family", 0, "me_life", 1), ("lebanese family", 0, "me_life", 1), ("istanbul cafe people", 0, "me_life", 1),
    ("russian family", 0, "eu_life", 1), ("moscow cafe people", 0, "eu_life", 1), ("italian family", 0, "eu_life", 1), ("spanish family", 0, "eu_life", 1), ("greek family", 0, "eu_life", 1),
    ("mexican family", 0, "latam_life", 1), ("brazilian family", 0, "latam_life", 1), ("filipino family", 0, "asia_life", 1), ("chinese family", 0, "asia_life", 1),
    # generic lifestyle = 0
    ("mother and daughter garden", 0, "generic_life", 2), ("family portrait outdoor", 0, "generic_life", 1), ("woman white dress garden", 0, "generic_life", 1), ("girl yellow dress", 0, "generic_life", 1),
    ("couple selfie", 0, "generic_life", 1), ("friends cafe", 0, "generic_life", 1), ("street style fashion woman", 0, "generic_life", 1), ("wedding photoshoot garden", 0, "generic_life", 1),
    ("kids birthday party", 0, "generic_life", 1), ("gym workout woman", 0, "generic_life", 1), ("beach family", 0, "generic_life", 1), ("picnic park family", 0, "generic_life", 1),
    ("restaurant friends dinner", 0, "generic_life", 1), ("greenhouse plants people", 0, "generic_life", 1), ("cooking kitchen family", 0, "generic_life", 1), ("office workers meeting", 0, "generic_life", 1),
    ("university students", 0, "generic_life", 1), ("tourists europe city", 0, "generic_life", 1), ("dog owner park", 0, "generic_life", 1), ("baby and mother", 0, "generic_life", 1),
    ("grandmother grandchild", 0, "generic_life", 1), ("teenagers street", 0, "generic_life", 1), ("flower garden woman", 0, "generic_life", 1), ("bride and flower girl", 0, "generic_life", 1),
]
if SET == "lifestyle": QUERIES = LIFESTYLE

last = [0.0]
def search(q, page):
    wait = 3.2 - (time.time() - last[0])
    if wait > 0: time.sleep(wait)
    last[0] = time.time()
    url = "https://api.openverse.org/v1/images/?" + urllib.parse.urlencode({"q": q, "page_size": 20, "page": page, "license_type": "all-cc", "mature": "false"})
    for attempt in range(4):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60)).get("results", [])
        except urllib.error.HTTPError as e:
            if e.code == 429: print("  429 openverse, sleep 65"); time.sleep(65)
            elif e.code == 404: return []  # no more pages
            else: print("  http", e.code); time.sleep(5)
        except Exception as e:
            print("  err", e); time.sleep(5)
    return []

def dl(args):
    fn, src = args
    if os.path.exists(fn) and os.path.getsize(fn) > 0: return True
    for attempt in range(3):
        try:
            data = urllib.request.urlopen(urllib.request.Request(src, headers=UA), timeout=90).read()
            if len(data) < 8000: return False
            open(fn, "wb").write(data); return True
        except Exception:
            time.sleep(1 + attempt)
    return False

items, seen = [], set()
for q, label, group, pages in QUERIES:
    cand, per_creator = [], {}
    for page in range(1, pages + 1):
        res = search(q, page)
        for r in res:
            u = r.get("url") or ""
            if not u or "upload.wikimedia.org" in u or r["id"] in seen: continue   # Commons is rate-limiting us right now
            if not re.search(r"\.(jpe?g|png)(\?|$)", u, re.I): continue
            c = r.get("creator") or "?"
            if per_creator.get(c, 0) >= 6: continue  # do not let one author fill the whole sample
            per_creator[c] = per_creator.get(c, 0) + 1
            seen.add(r["id"]); cand.append(r)
        if len(res) < 20: break
    jobs = [(f"{OUT}/img/{group}_{re.sub(r'[^a-z0-9]+', '_', q)[:24]}_{r['id'][:8]}.jpg", r["url"]) for r in cand]
    with ThreadPoolExecutor(4) as ex: ok = list(ex.map(dl, jobs))
    got = 0
    for r, (fn, _), o in zip(cand, jobs, ok):
        if not o: continue
        items.append({"file": fn, "label": label, "group": group, "root": "ov:" + q, "title": (r.get("title") or "")[:80], "creator": (r.get("creator") or "")[:40],
                      "license": f"{r.get('license')}-{r.get('license_version')}", "source": r.get("source"), "page": r.get("foreign_landing_url")}); got += 1
    print(f"{q!r} [{group}, {label}]: {len(cand)} candidates, {got} downloaded, total {len(items)}", flush=True)
    json.dump({"items": items}, open(f"{OUT}/manifest.json", "w"), ensure_ascii=False)
print("done", len(items))
