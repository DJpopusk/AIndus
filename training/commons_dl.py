"""Builds a scene dataset from Wikimedia Commons: Indian dances, weddings, streets and festivals (label 1)
against Georgian, Caucasian, Slavic, Turkish, Latin and other dances, weddings and streets (label 0).

python3 commons_dl.py            -> commons/manifest.json + commons/img/*.jpg (+ commons/dl.log)
Slow and polite: the Commons API returns 429 on frequent requests, and so do thumbnails.
"""
import json, os, random, re, time, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor
import threading

UA = {"User-Agent": "aindu-training/0.1 (personal meme project; contact via github)"}
OUT = "commons"
os.makedirs(f"{OUT}/img", exist_ok=True)
random.seed(11)
LOG = open(f"{OUT}/dl.log", "a")
def log(*a):
    line = " ".join(str(x) for x in a); print(line, flush=True); LOG.write(line + "\n"); LOG.flush()

API_GAP, DL_GAP, DL_THREADS = 2.5, 1.0, 1
name_lock = threading.Lock()
counter = [0]
last_api = [0.0]
def api(params):
    url = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode({**params, "format": "json"})
    for attempt in range(6):
        wait = API_GAP - (time.time() - last_api[0])
        if wait > 0: time.sleep(wait)
        last_api[0] = time.time()
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90))
        except urllib.error.HTTPError as e:
            if e.code == 429: log("  429 api, sleep", 30 * (attempt + 1)); time.sleep(30 * (attempt + 1))
            else: log("  http", e.code, "sleep 10"); time.sleep(10)
        except Exception as e:
            log("  err", e); time.sleep(10)
    return {}

# (category, label, group, file limit, subcategory depth)
ROOTS = [
    ("Folk dance of India", 1, "ind_dance", 60, 1),
    ("Bharatanatyam", 1, "ind_dance", 30, 0),
    ("Kathak", 1, "ind_dance", 30, 0),
    ("Bhangra", 1, "ind_dance", 40, 1),
    ("Garba", 1, "ind_dance", 30, 0),
    ("Bollywood dance performances", 1, "ind_dance", 30, 0),
    ("Georgian dance", 0, "georgian", 45, 1),
    ("Dance of Georgia (country)", 0, "georgian", 45, 1),
    ("Lezginka", 0, "georgian", 24, 0),
    ("Sukhishvili Georgian National Ballet", 0, "georgian", 18, 1),
    ("Female folk dance from Georgia (country)", 0, "georgian", 36, 0),
    ("Male dancers from Georgia (country)", 0, "georgian", 24, 1),
    ("Female dancers from Georgia (country)", 0, "georgian", 24, 1),
    ("Dancers from Georgia (country)", 0, "georgian", 24, 1),
    ("Erisioni", 0, "georgian", 18, 0),
    ("Samaia", 0, "georgian", 10, 0),
    ("Weddings in Georgia (country)", 0, "georgian", 24, 1),
    ("Streets in Tbilisi", 0, "georgian", 36, 0),
    ("Dance of Armenia", 0, "caucasus", 30, 1),
    ("Armenian State Dance Ensemble", 0, "caucasus", 24, 0),
    ("Armenian State Song & Dance Ensemble", 0, "caucasus", 24, 0),
    ("Kochari (Armenia)", 0, "caucasus", 18, 0),
    ("Yarkhushta", 0, "caucasus", 12, 0),
    ("Armenian folk dance", 0, "caucasus", 24, 1),
    ("Dance of Azerbaijan", 0, "caucasus", 30, 1),
    ("Folk dance of Azerbaijan", 0, "caucasus", 30, 1),
    ("Folk dances in Azerbaijan", 0, "caucasus", 24, 0),
    ("Ossetian folk dance", 0, "caucasus", 18, 0),
    ("Makhmud Esambayev", 0, "caucasus", 12, 0),
    ("Kurdish dance in Iran", 0, "caucasus", 27, 0),
    ("Dance of Kurdistan", 0, "caucasus", 12, 1),
    ("Wedding ceremonies in India", 1, "ind_wedding", 50, 0),
    ("Bengali Hindu weddings", 1, "ind_wedding", 30, 0),
    ("Holi in India", 1, "ind_festival", 40, 0),
    ("Ganesh Chaturthi", 1, "ind_festival", 30, 0),
    ("Streets in Mumbai", 1, "ind_street", 40, 0),
    ("Markets in India", 1, "ind_street", 30, 0),
    ("People in India", 1, "ind_people", 40, 0),
    ("Streets in Dhaka", 1, "sasia_street", 25, 0),
    ("Russian folk dance", 0, "slavic", 28, 1),
    ("Russian concert dance", 0, "slavic", 24, 1),
    ("Russian plyaska", 0, "slavic", 18, 0),
    ("Quadrille (folk dance)", 0, "slavic", 18, 0),
    ("Moiseyev Ballet", 0, "slavic", 24, 0),
    ("Dance ensemble Gzhel", 0, "slavic", 18, 0),
    ("Kalinka", 0, "slavic", 10, 0),
    ("Russian tanok", 0, "slavic", 12, 0),
    ("Ukrainian folk dance", 0, "slavic", 28, 1),
    ("Pavlo Virsky Ukrainian National Folk Dance Ensemble", 0, "slavic", 18, 0),
    ("Folk dance of Bulgaria", 0, "slavic", 28, 1),
    ("Horos of Bulgaria", 0, "slavic", 18, 0),
    ("Folk dance of Serbia", 0, "slavic", 28, 1),
    ("Kolo (dance)", 0, "slavic", 18, 0),
    ("Ensemble Venac", 0, "slavic", 12, 0),
    ("Folk dance of Romania", 0, "slavic", 28, 1),
    ("Călușari", 0, "slavic", 18, 0),
    ("Hora (dance)", 0, "slavic", 18, 0),
    ("Folk dance of Poland", 0, "slavic", 28, 1),
    ("Folk dance of Hungary", 0, "slavic", 28, 1),
    ("Folk dance of Belarus", 0, "slavic", 18, 1),
    ("Folk dance of Turkey", 0, "turkish", 28, 1),
    ("Dance of Turkey", 0, "turkish", 28, 1),
    ("Zeybek (Turkish folk dance)", 0, "turkish", 12, 0),
    ("Kılıç Kalkan", 0, "turkish", 12, 0),
    ("Fire of Anatolia", 0, "turkish", 18, 0),
    ("Whirling dervishes", 0, "turkish", 24, 0),
    ("Streets in Istanbul", 0, "turkish", 28, 0),
    ("Dabke", 0, "mideast", 24, 0),
    ("Belly dance", 0, "mideast", 25, 1),
    ("Raqs Sharqi", 0, "mideast", 18, 0),
    ("Arab dance", 0, "mideast", 25, 1),
    ("Dance of Iran", 0, "mideast", 25, 1),
    ("Dance of Yemen", 0, "mideast", 12, 0),
    ("Dance of Iraq", 0, "mideast", 12, 0),
    ("Dance of Syria", 0, "mideast", 12, 0),
    ("Sizdah Be-dar", 0, "mideast", 25, 0),
    ("Weddings in Iran", 0, "mideast", 25, 0),
    ("Weddings in Morocco", 0, "mideast", 20, 0),
    ("Eid al-Fitr", 0, "mideast", 25, 0),
    ("Streets in Cairo", 0, "mideast", 25, 0),
    ("Attan", 0, "mideast", 18, 0),
    ("Uzbek dance", 0, "casia", 24, 1),
    ("Dance of Uzbekistan", 0, "casia", 24, 1),
    ("Folk dance of Uzbekistan", 0, "casia", 24, 0),
    ("Dance of Kazakhstan", 0, "casia", 24, 1),
    ("Dance of Kyrgyzstan", 0, "casia", 18, 1),
    ("Dance of Tajikistan", 0, "casia", 18, 1),
    ("Dance of Mongolia", 0, "casia", 18, 1),
    ("Flamenco dancers", 0, "europe", 22, 0),
    ("Irish dance", 0, "europe", 22, 1),
    ("Tarantella", 0, "europe", 22, 0),
    ("Schuhplattler", 0, "europe", 21, 0),
    ("Highland dancing", 0, "europe", 15, 0),
    ("Kalamatianos", 0, "europe", 12, 0),
    ("Sirtaki", 0, "europe", 10, 0),
    ("Morris dancing", 0, "europe", 22, 1),
    ("Trachten- und Schützenzug (Oktoberfest)", 0, "europe", 22, 0),
    ("Oktoberfest at night", 0, "europe", 18, 0),
    ("Folk dance of Greece", 0, "europe", 22, 1),
    ("Folk dance of Spain", 0, "europe", 22, 1),
    ("Folk dance of Italy", 0, "europe", 22, 1),
    ("Folk dance of Portugal", 0, "europe", 22, 1),
    ("Sardana", 0, "europe", 18, 0),
    ("Quality images of streets in Moscow", 0, "europe", 22, 0),
    ("Streets in Moscow", 0, "europe", 22, 0),
    ("Samba dancers", 0, "latam", 22, 0),
    ("Salsa (dance)", 0, "latam", 22, 0),
    ("Capoeira", 0, "latam", 22, 0),
    ("Marinera", 0, "latam", 22, 0),
    ("Tango", 0, "latam", 22, 0),
    ("Drums section of Rio de Janeiro carnival", 0, "latam", 22, 0),
    ("Folk dance of Mexico", 0, "latam", 22, 1),
    ("Jarabe tapatío", 0, "latam", 12, 0),
    ("Maasai dance", 0, "africa", 20, 0),
    ("Gumboot dance", 0, "africa", 10, 0),
    ("Weddings in Nigeria", 0, "africa", 20, 0),
    ("Dance of Nigeria", 0, "africa", 20, 1),
    ("Dance of Ghana", 0, "africa", 20, 1),
    ("Dance of Kenya", 0, "africa", 20, 1),
    ("Dance of South Africa", 0, "africa", 20, 1),
    ("Dance of Ethiopia", 0, "africa", 20, 1),
    ("Dance of Senegal", 0, "africa", 18, 1),
    ("Kecak", 0, "asia", 20, 0),
    ("Legong", 0, "asia", 20, 0),
    ("Khmer classical dance", 0, "asia", 20, 0),
    ("Lion dance in 2023", 0, "asia", 20, 0),
    ("Dance of China", 0, "asia", 20, 1),
    ("Dance of Korea", 0, "asia", 20, 1),
    ("Dance of Japan", 0, "asia", 20, 1),
    ("Bon Odori", 0, "asia", 20, 0),
    ("Dance of Thailand", 0, "asia", 20, 1),
    ("Dance of the Philippines", 0, "asia", 20, 1),
    ("Dance of Vietnam", 0, "asia", 20, 1),
    ("Dance of Indonesia", 0, "asia", 20, 1),
    ("Ballet performances", 0, "modern", 20, 0),
    ("Ballet dancers", 0, "modern", 20, 0),
    ("Breakdance", 0, "modern", 20, 0),
    ("Hip hop dancers", 0, "modern", 20, 0),
    ("1986 USSR breakdance championships (first in USSR, held in Tallinn)", 0, "modern", 18, 0),
    ("Swing dance", 0, "modern", 20, 0),
    ("Contemporary dance", 0, "modern", 20, 0),
    ("Ballroom dance", 0, "modern", 20, 0),
    ("Square dance", 0, "modern", 20, 0),
    ("Zumba", 0, "modern", 20, 0),
    ("Cheerleading", 0, "modern", 20, 1),
    ("K-pop", 0, "modern", 20, 1),
    ("Quality images of cats", 0, "generic", 24, 0),
    ("Quality images of dogs", 0, "generic", 24, 0),
    ("Quality images of automobiles", 0, "generic", 24, 0),
    ("Quality images of food", 0, "generic", 24, 0),
    ("Quality images of landscapes", 0, "generic", 24, 0),
    ("Screenshots of video games", 0, "generic", 24, 0),
    ("Quality images of people", 0, "generic", 25, 0),
    ("Selfies", 0, "generic", 24, 0),
    ("Quality images of birds", 0, "generic", 18, 0),
]

BAD_SUBCAT = re.compile(r"art\b|painting|drawing|stamp|logo|\bmap|video|audio|music|instrument|costume|dress|book|poster|magazine|film\b|movie|coin|sculpture|statue|monument|building|architecture|flag|sheet|notation|program|ephemera|by year|by country|by city|by name|history|historical|camouflage|guitar|cajon|\bmode\b|museum|award|composer|interpreter|director|choreographer|sign|furniture|cleaning|tree|highway|bus\b|terminus|make-up|mask|food|dish|flower|vehicle|necklace|decoration|photography|venue|clothes|tradition|surname|schools?$|companies|wear|scenic|programmes|ice danc|ballet dancers from|figure skat|\bTV\b|television|serie|album|song|singer|actor|actress|born in|deaths|births|people of|pronunciation|writers|politicians", re.I)
BAD_FILE = re.compile(r"\bmap\b|logo|diagram|stamp|poster|cover|flag|coat of arms|seal\b|chart|scan|sheet music|\.svg|\.pdf|\.webm|\.ogv|\.gif|\.tif", re.I)

def list_files(cat):
    files, cont = [], {}
    for _ in range(3):  # up to 3x200 files
        d = api({"action": "query", "generator": "categorymembers", "gcmtitle": f"Category:{cat}", "gcmtype": "file", "gcmlimit": 200,
                 "prop": "imageinfo", "iiprop": "url|size|mime|extmetadata", "iiurlwidth": 640, "iiextmetadatafilter": "LicenseShortName|Artist|Credit", **cont})
        for p in d.get("query", {}).get("pages", {}).values():
            ii = (p.get("imageinfo") or [{}])[0]
            if not ii.get("thumburl") or not ii.get("mime", "").startswith(("image/jpeg", "image/png")): continue
            if ii.get("width", 0) < 300 or ii.get("height", 0) < 300 or BAD_FILE.search(p["title"]): continue
            em = ii.get("extmetadata", {})
            files.append({"title": p["title"], "url": ii["thumburl"], "page": ii.get("descriptionurl"), "w": ii["width"], "h": ii["height"],
                          "license": em.get("LicenseShortName", {}).get("value", ""), "artist": re.sub("<[^>]+>", "", em.get("Artist", {}).get("value", ""))[:80]})
        cont = d.get("continue", {})
        if "gcmcontinue" not in cont: break
    return files

def list_subcats(cat):
    d = api({"action": "query", "generator": "categorymembers", "gcmtitle": f"Category:{cat}", "gcmtype": "subcat", "gcmlimit": 60, "prop": "categoryinfo"})
    out = []
    for p in d.get("query", {}).get("pages", {}).values():
        t = p["title"].replace("Category:", "")
        if BAD_SUBCAT.search(t): continue
        out.append((t, p.get("categoryinfo", {}).get("files", 0)))
    return out

manifest_path = f"{OUT}/manifest.json"
manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {"items": [], "done_roots": []}
seen = {it["title"] for it in manifest["items"]}
counter[0] = len(manifest["items"])

def download(item):
    with name_lock:
        counter[0] += 1; idx = counter[0]
    fn = f"{OUT}/img/{idx:05d}_{re.sub(r'[^A-Za-z0-9]+', '_', item['title'][5:])[:60]}.jpg"
    for attempt in range(5):
        try:
            data = urllib.request.urlopen(urllib.request.Request(item["url"], headers=UA), timeout=90).read()
            open(fn, "wb").write(data)
            time.sleep(DL_GAP)
            return fn
        except urllib.error.HTTPError as e:
            if e.code == 429: log("  429 thumb, sleep", 40 * (attempt + 1)); time.sleep(40 * (attempt + 1))
            elif e.code == 404: return None
            else: time.sleep(8)
        except Exception as e:
            log("  dl err", e); time.sleep(8)
    return None

for cat, label, group, cap, depth in ROOTS:
    if cat in manifest["done_roots"]: continue
    pool = list_files(cat)
    if depth > 0:
        for sub, nfiles in list_subcats(cat)[:12]:
            if nfiles == 0: continue
            pool += [dict(f, sub=sub) for f in list_files(sub)[:max(20, cap // 2)]]
    pool = [f for f in pool if f["title"] not in seen]
    random.shuffle(pool)
    got = 0
    with ThreadPoolExecutor(DL_THREADS) as ex:
        results = list(ex.map(download, pool[:cap]))
    for f, fn in zip(pool[:cap], results):
        if not fn: continue
        manifest["items"].append({**f, "file": fn, "label": label, "group": group, "root": cat}); seen.add(f["title"]); got += 1
    manifest["done_roots"].append(cat)
    json.dump(manifest, open(manifest_path, "w"), ensure_ascii=False)
    log(f"{cat!r} [{group}, label {label}]: pool {len(pool)}, got {got}, total {len(manifest['items'])}")

log("done", len(manifest["items"]), "images")
