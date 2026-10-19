import json, os, urllib.request
n = json.load(open("/tmp/n.json"))
os.makedirs("samples", exist_ok=True)
seen = {}
for notice in n["notices"]:
    for f in notice.get("files", []):
        ext = f["name"].rsplit(".", 1)[-1].lower()
        if ext not in ("hwp", "hwpx", "pdf") or seen.get(ext, 0) >= 2:
            continue
        req = urllib.request.Request(f["url"], headers={"User-Agent": "Mozilla/5.0", "Origin": "https://soffmadldi1-dev.github.io"})
        try:
            r = urllib.request.urlopen(req, timeout=40)
            body = r.read()
            h = dict(r.headers)
            print("OK", ext, r.status, len(body), h.get("Content-Type"), "ACAO=", h.get("Access-Control-Allow-Origin"), "CD=", h.get("Content-Disposition", "")[:80], body[:8])
            if len(body) < 3_000_000:
                seen[ext] = seen.get(ext, 0) + 1
                open("samples/sample%d.%s" % (seen[ext], ext), "wb").write(body)
        except Exception as e:
            print("ERR", ext, f["url"][:90], e)
print(seen)
