#!/usr/bin/env python3
"""Adds your own tracks to the playlist.

    scripts/add-music.py ~/Music/tunak.mp3 ~/Downloads/desi/        # add files and folders
    scripts/add-music.py track.mp3 --tag holi,bhangra               # which celebrations it fits
    scripts/add-music.py track.mp3 --best                           # cut the loudest part instead of the start
    scripts/add-music.py track.mp3 --start 45 --len 90              # by hand: 90 seconds from 0:45
    scripts/add-music.py --list                                     # what is in the playlist now
    scripts/add-music.py --remove tunak                             # remove a track (by file name)

Tags are genres (bollywood, bhangra, dhol, classic, wedding, festival, street)
and celebration themes (holi, diwali, wedding, bollywood, street).
The celebration theme is picked at random, and the track comes from those whose tags match it.

Tracks added by this script are marked "private": true. They are for personal use:
`scripts/pack.sh` warns about them, and the extension must not be published with someone else's music.
"""
import argparse, json, os, re, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SONGS_DIR = os.path.join(ROOT, "extension", "assets", "songs")
MANIFEST = os.path.join(SONGS_DIR, "songs.json")
AUDIO_EXT = {".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".oga", ".opus", ".webm", ".mp4", ".mkv"}
TAGS = ["bollywood", "bhangra", "dhol", "classic", "wedding", "festival", "street",  # genres
        "holi", "diwali"]                                                            # and celebration themes


def load():
    return json.load(open(MANIFEST, encoding="utf-8")) if os.path.exists(MANIFEST) else []


def save(songs):
    json.dump(songs, open(MANIFEST, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


def probe(path, entries):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", entries, "-of", "default=nw=1:nk=1", path],
                         capture_output=True, text=True).stdout.strip().splitlines()
    return out


def best_window(path, length):
    """The most energetic part of a track: the window with the highest average loudness (needs numpy)."""
    try:
        import numpy as np
    except ImportError:
        return 0.0
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "4000", "-f", "s16le", "-"],
                         capture_output=True).stdout
    x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768
    sec = len(x) // 4000
    if sec <= length:
        return 0.0
    rms = np.sqrt((x[: sec * 4000].reshape(sec, 4000) ** 2).mean(1))
    cum = np.concatenate([[0], np.cumsum(rms)])
    scores = cum[length:] - cum[:-length]
    return float(int(scores.argmax()))


def add(path, args, songs):
    title_artist = probe(path, "format_tags=title,format_tags=artist")
    dur = probe(path, "format=duration")
    if not dur:
        print(f"  пропускаю {os.path.basename(path)}: ffprobe не понял файл")
        return False
    dur = float(dur[0])
    name = re.sub(r"[^a-zA-Z0-9]+", "_", os.path.splitext(os.path.basename(path))[0]).strip("_").lower()[:40] or "track"
    while any(s["file"] == f"{name}.ogg" for s in songs):
        name += "_2"
    take = min(args.len, max(5, int(dur) - 1))
    start = args.start if args.start is not None else (best_window(path, take) if args.best else 0.0)
    fade = max(1, take - 3)
    out = os.path.join(SONGS_DIR, f"{name}.ogg")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(start), "-t", str(take), "-i", path,
                    "-af", f"afade=t=in:d=1,afade=t=out:st={fade}:d=3,loudnorm=I=-16",
                    "-vn", "-ac", "2", "-ar", "44100", "-c:a", "libvorbis", "-q:a", "4", out], check=True)
    title = " — ".join(x for x in reversed(title_artist[:2]) if x) or os.path.splitext(os.path.basename(path))[0]
    songs.append({"file": f"{name}.ogg", "title": title[:70], "license": "личная копия (не для публикации)",
                  "source": os.path.basename(path), "tags": args.tag, "private": True})
    print(f"  + {name}.ogg  «{title[:48]}»  {take} с с {int(start)}-й, теги: {', '.join(args.tag) or '—'}")
    return True


def main():
    ap = argparse.ArgumentParser(description="добавить свои треки в плейлист ИИндуса", add_help=True)
    ap.add_argument("paths", nargs="*", help="файлы или папки с музыкой")
    ap.add_argument("--tag", default="bollywood", help="теги тем через запятую: " + ", ".join(TAGS))
    ap.add_argument("--len", type=int, default=120, help="длина куска в секундах (по умолчанию 120)")
    ap.add_argument("--start", type=float, default=None, help="с какой секунды резать")
    ap.add_argument("--best", action="store_true", help="выбрать самый энергичный кусок трека")
    ap.add_argument("--list", action="store_true", help="показать плейлист")
    ap.add_argument("--remove", metavar="ИМЯ", help="удалить трек по имени файла")
    args = ap.parse_args()
    args.tag = [t.strip() for t in args.tag.split(",") if t.strip()]
    for t in args.tag:
        if t not in TAGS:
            print(f"неизвестный тег {t!r}; доступны: {', '.join(TAGS)}"); sys.exit(1)
    if not shutil.which("ffmpeg"):
        print("нужен ffmpeg: brew install ffmpeg"); sys.exit(1)

    songs = load()
    if args.list:
        for s in songs:
            mark = "🔒" if s.get("private") else "  "
            print(f"{mark} {s['file']:28s} {', '.join(s.get('tags', [])):24s} {s['title'][:44]}")
        print(f"\nвсего {len(songs)}, из них своих {sum(1 for s in songs if s.get('private'))}")
        return
    if args.remove:
        keep = [s for s in songs if args.remove not in s["file"]]
        for s in songs:
            if s not in keep:
                print("  −", s["file"])
                try: os.remove(os.path.join(SONGS_DIR, s["file"]))
                except FileNotFoundError: pass
        save(keep); print(f"осталось {len(keep)}")
        return
    if not args.paths:
        ap.print_help(); return

    files = []
    for p in args.paths:
        p = os.path.expanduser(p)
        if os.path.isdir(p):
            files += [os.path.join(p, f) for f in sorted(os.listdir(p)) if os.path.splitext(f)[1].lower() in AUDIO_EXT]
        elif os.path.splitext(p)[1].lower() in AUDIO_EXT:
            files.append(p)
        else:
            print(f"  пропускаю {p}: не аудио")
    n = sum(add(f, args, songs) for f in files)
    save(songs)
    print(f"\nдобавлено {n}, в плейлисте {len(songs)}. Перезагрузи расширение: chrome://extensions → ↻")


if __name__ == "__main__":
    main()
