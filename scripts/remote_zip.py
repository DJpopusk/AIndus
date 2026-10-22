"""Reads a zip archive over the network in chunks (HTTP Range): the directory and only the needed files, no full download."""
import io, time, urllib.request

UA = "aindu-dance-fetch/1.0 (+https://github.com)"


class RemoteFile(io.RawIOBase):
    def __init__(self, url):
        self.url, self.pos = url, 0
        # size from the Content-Range of a request for the first byte (Zenodo answers 403 to HEAD)
        req = urllib.request.Request(url, headers={'Range': 'bytes=0-0', 'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            self.url = r.geturl()                       # GitHub and Zenodo redirect to their storage
            self.size = int(r.headers['Content-Range'].split('/')[-1])
        self.cache = {}

    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def readinto(self, b):
        n = min(len(b), self.size - self.pos)
        if n <= 0: return 0
        data = self._get(self.pos, n)
        b[:len(data)] = data; self.pos += len(data)
        return len(data)

    def _get(self, start, n):
        # 1 MB chunks with a cache: zipfile reads in small pieces and every request is a network round trip
        CH = 1 << 20
        out = bytearray()
        while n > 0:
            blk = start // CH
            if blk not in self.cache:
                lo, hi = blk * CH, min(self.size, (blk + 1) * CH) - 1
                req = urllib.request.Request(self.url, headers={'Range': f'bytes={lo}-{hi}', 'User-Agent': UA})
                for attempt in range(4):                # the connection can drop mid-chunk: retry
                    try:
                        data = urllib.request.urlopen(req, timeout=120).read()
                        if len(data) == hi - lo + 1: break
                    except Exception:
                        data = b''
                    time.sleep(2 + 2 * attempt)
                if len(data) != hi - lo + 1: raise IOError(f'не удалось прочитать байты {lo}-{hi}')
                self.cache[blk] = data
            chunk = self.cache[blk][start - blk * CH: start - blk * CH + n]
            out += chunk; start += len(chunk); n -= len(chunk)
            if not chunk: break
        return bytes(out)
