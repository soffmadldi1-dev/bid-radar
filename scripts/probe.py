import hashlib, json, os, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone
KST = timezone(timedelta(hours=9))
raw = os.environ["SERVICE_KEY"].strip()
dec = urllib.parse.unquote(raw)
print("secret sha256 prefix:", hashlib.sha256(dec.encode()).hexdigest()[:12], "has%:", "%" in raw)
key = raw if "%" in raw else urllib.parse.quote(raw, safe="")
end = datetime.now(KST); beg = end - timedelta(days=3)
def call(path, extra=""):
    url = ("https://apis.data.go.kr/1230000/%s?serviceKey=%s&numOfRows=3&pageNo=1&inqryDiv=1&inqryBgnDt=%s&inqryEndDt=%s&type=json%s"
           % (path, key, beg.strftime("%Y%m%d%H%M"), end.strftime("%Y%m%d%H%M"), extra))
    try:
        body = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "bid-radar/1.0"}), timeout=40).read().decode("utf-8", "replace")
    except Exception as e:
        print("##", path, "ERROR", e); return
    print("##", path, "->", body[:200].replace("\n", " ") if not body.lstrip().startswith("{") else "")
    try:
        d = json.loads(body)
    except Exception:
        print(body[:500]); return
    b = d.get("response", {}).get("body", {})
    print("header", d.get("response", {}).get("header"), "total", b.get("totalCount"))
    items = b.get("items") or []
    if isinstance(items, dict): items = items.get("item", [])
    if isinstance(items, dict): items = [items]
    for it in items[:2]:
        print(json.dumps(it, ensure_ascii=False, indent=0)[:6000])
call("ad/BidPublicInfoService/getBidPblancListInfoServc")
for op in ["getPublicPrcureThngInfoServc", "getPublicPrcureThngInfoServcPPSSrch"]:
    call("ao/HrcspSsstndrdInfoService/" + op)
