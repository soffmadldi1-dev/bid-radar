# -*- coding: utf-8 -*-
"""
공고 첨부파일(제안요청서·과업지시서·공고문)을 내려받아 '본문 글자'만 뽑아 두는 스크립트.

- 화면의 [🤖 AI 의사결정 브리프] 버튼이 이 글자를 읽어 Claude에게 보냅니다.
- 브라우저는 나라장터 파일을 직접 못 받기 때문에(보안 정책), 매일 수집할 때 여기서 미리 받아 둡니다.
- 결과: data/rfp/bid-<공고번호>.json, data/rfp/spec-<사전규격번호>.json
- 이미 뽑아 둔 공고는 건너뜁니다(첨부파일 목록이 바뀐 경우만 다시 뽑음). 목록에서 빠진 공고의 파일은 지웁니다.
- 파일 하나가 실패해도 나머지는 계속 진행합니다. 이 스크립트가 실패해도 공고 수집에는 영향이 없습니다.

필요한 라이브러리: olefile(한글 HWP), pypdf(PDF)  ->  워크플로에서 pip install 합니다.
"""

import hashlib
import io
import json
import os
import re
import struct
import sys
import time
import urllib.request
import zipfile
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

try:
    import olefile
except ImportError:          # 없으면 HWP만 건너뜁니다
    olefile = None
try:
    from pypdf import PdfReader
except ImportError:          # 없으면 PDF만 건너뜁니다
    PdfReader = None

KST = timezone(timedelta(hours=9))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
RFP_DIR = os.path.join(DATA_DIR, "rfp")

MAX_FILES = 4                 # 공고 하나당 최대 몇 개 파일을 읽을지 (제안요청서 계열 우선)
MAX_FILE_BYTES = 15_000_000   # 이보다 큰 파일은 건너뜁니다 (15MB)
MAX_TEXT_CHARS = 150_000      # 공고 하나당 저장할 최대 글자 수 (약 10만 토큰)
DOWNLOAD_TIMEOUT = 25
MAX_NETWORK_FAILURES = 8      # 접속 실패가 이만큼 쌓이면(나라장터 서버 불통) 이번 실행은 멈추고 다음에 다시 합니다
WORKERS = 6                   # 동시에 처리할 공고 수
TIME_BUDGET_SEC = 12 * 60     # 이 시간이 지나면 남은 공고는 다음 실행으로 미룹니다 (워크플로 제한 20분 안쪽)
SUPPORTED = ("hwp", "hwpx", "pdf", "txt")


def log(message):
    print("[RFP추출] " + message, flush=True)


# ---------------------------------------------------------------------------
# 1. 파일 형식별 글자 뽑기
# ---------------------------------------------------------------------------

def text_from_hwp(data):
    """한글(HWP 5.0) 파일: OLE 안의 BodyText/SectionN 을 풀어 문단 글자(PARA_TEXT)만 모읍니다."""
    if olefile is None:
        raise RuntimeError("olefile 라이브러리가 없습니다")
    ole = olefile.OleFileIO(io.BytesIO(data))
    header = ole.openstream("FileHeader").read()
    flags = struct.unpack("<I", header[36:40])[0]
    if flags & 0x02:
        raise RuntimeError("암호가 걸린 HWP입니다")
    if flags & 0x04:
        raise RuntimeError("배포용(읽기 전용) HWP라 본문을 읽을 수 없습니다")
    compressed = bool(flags & 0x01)

    sections = sorted(
        (entry for entry in ole.listdir() if len(entry) == 2 and entry[0] == "BodyText"
         and entry[1].startswith("Section")),
        key=lambda entry: int(re.sub(r"\D", "", entry[1]) or 0),
    )
    paragraphs = []
    for entry in sections:
        raw = ole.openstream(entry).read()
        if compressed:
            raw = zlib.decompress(raw, -15)
        paragraphs.extend(hwp_records_to_text(raw))
    return "\n".join(paragraphs)


def hwp_records_to_text(raw):
    """HWP 레코드 묶음에서 문단 글자(태그 67)만 꺼냅니다."""
    out = []
    pos = 0
    while pos + 4 <= len(raw):
        header = struct.unpack_from("<I", raw, pos)[0]
        pos += 4
        tag = header & 0x3FF
        size = (header >> 20) & 0xFFF
        if size == 0xFFF:
            size = struct.unpack_from("<I", raw, pos)[0]
            pos += 4
        body = raw[pos:pos + size]
        pos += size
        if tag == 67:                      # HWPTAG_PARA_TEXT
            out.append(hwp_para_text(body))
    return [line for line in out if line.strip()]


# 글자 안에 섞인 제어문자: 1칸짜리(줄바꿈 등)와 8칸짜리(표·그림 등 개체 자리표시)
HWP_CHAR_CONTROLS = {0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31}


def hwp_para_text(body):
    chars = struct.unpack("<%dH" % (len(body) // 2), body[:len(body) // 2 * 2])
    text = []
    i = 0
    while i < len(chars):
        code = chars[i]
        if code >= 32:
            text.append(chr(code))
            i += 1
        elif code in HWP_CHAR_CONTROLS:
            if code in (10, 13):
                text.append("\n")
            i += 1
        else:
            if code == 9:
                text.append("\t")
            i += 8
    return "".join(text).strip()


def text_from_hwpx(data):
    """한글(HWPX) 파일: 압축을 풀어 Contents/sectionN.xml 의 글자(<hp:t>)를 문단(<hp:p>)별로 모읍니다."""
    archive = zipfile.ZipFile(io.BytesIO(data))
    names = sorted(
        (n for n in archive.namelist() if re.match(r"Contents/section\d+\.xml$", n, re.I)),
        key=lambda n: int(re.sub(r"\D", "", n.rsplit("/", 1)[-1]) or 0),
    )
    paragraphs = []
    for name in names:
        xml = archive.read(name).decode("utf-8", errors="replace")
        for para in re.findall(r"<hp:p[ >].*?</hp:p>", xml, re.S):
            # 문단 안에 표가 들어 있으면 표 칸의 문단이 따로 잡히므로 여기서는 직접 글자만 모읍니다.
            parts = re.findall(r"<hp:t(?: [^>]*)?>(.*?)</hp:t>", para, re.S)
            line = "".join(re.sub(r"<[^>]+>", "", p) for p in parts)
            line = (line.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
                        .replace("&apos;", "'").replace("&amp;", "&")).strip()
            if line:
                paragraphs.append(line)
    # 중첩 문단(표 안 문단)은 바깥 문단 정규식에도 걸려 중복될 수 있어, 바로 앞줄과 같은 줄은 지웁니다.
    deduped = [p for i, p in enumerate(paragraphs) if i == 0 or p != paragraphs[i - 1]]
    return "\n".join(deduped)


def text_from_pdf(data):
    if PdfReader is None:
        raise RuntimeError("pypdf 라이브러리가 없습니다")
    reader = PdfReader(io.BytesIO(data))
    pages = []
    for number, page in enumerate(reader.pages, 1):
        pages.append("[%d쪽]\n%s" % (number, (page.extract_text() or "").strip()))
    text = "\n".join(pages)
    if len(re.sub(r"\[\d+쪽\]|\s", "", text)) < 50:
        raise RuntimeError("글자가 없는 PDF입니다(스캔 이미지일 가능성). 화면에서 파일을 직접 올려 주세요")
    return text


def extract_text(name, data):
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    # 확장자가 없거나 틀린 경우를 대비해 파일 첫 바이트로도 판단합니다.
    if data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        ext = "hwp"
    elif data[:4] == b"PK\x03\x04" and ext not in ("hwpx",):
        ext = "hwpx" if b"Contents/" in data[:4000] or ext == "" else ext
    elif data[:5] == b"%PDF-":
        ext = "pdf"
    if ext == "hwp":
        return text_from_hwp(data)
    if ext == "hwpx":
        return text_from_hwpx(data)
    if ext == "pdf":
        return text_from_pdf(data)
    if ext == "txt":
        return data.decode("utf-8", errors="replace")
    raise RuntimeError("지원하지 않는 형식(%s)" % ext)


def clean(text):
    text = text.replace("\r", "")
    text = re.sub(r"[ \t　]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ---------------------------------------------------------------------------
# 2. 공고별 처리
# ---------------------------------------------------------------------------

def file_ext(name):
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def pick_files(files):
    """제안요청서 계열 -> 나머지 순서로, 읽을 수 있는 형식만 최대 MAX_FILES개.
    같은 문서가 HWP와 PDF로 둘 다 올라온 경우가 많아, 이름(확장자 제외)이 같으면 하나만 고릅니다."""
    picked, seen_stems = [], set()
    preference = {"hwpx": 0, "hwp": 1, "pdf": 2, "txt": 3}
    ordered = sorted(files, key=lambda f: (not f.get("rfp"), preference.get(file_ext(f["name"]), 9)))
    for f in ordered:
        ext = file_ext(f["name"])
        if ext not in SUPPORTED and not f["name"].startswith(("첨부파일", "규격서")):
            continue
        stem = re.sub(r"\.[^.]+$", "", f["name"])
        if stem in seen_stems:
            continue
        seen_stems.add(stem)
        picked.append(f)
        if len(picked) >= MAX_FILES:
            break
    return picked


class NetworkError(RuntimeError):
    """서버 접속 문제(시간 초과 등). 파일 자체 문제와 달리 다음 실행 때 다시 시도합니다."""


def download(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (bid-radar)"})
    last = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT) as response:
                data = response.read(MAX_FILE_BYTES + 1)
            if len(data) > MAX_FILE_BYTES:
                raise RuntimeError("파일이 너무 큽니다(15MB 초과)")
            return data
        except RuntimeError:
            raise
        except Exception as e:      # 일시적인 접속 오류는 잠시 쉬었다 다시
            last = e
            time.sleep(3 * (attempt + 1))
    raise NetworkError("내려받기 실패: %s" % last)


def signature(files):
    return hashlib.sha1(json.dumps([f["url"] for f in files], ensure_ascii=False).encode()).hexdigest()[:12]


def process(kind, item):
    """공고 하나의 첨부파일을 읽어 data/rfp/<kind>-<id>.json 으로 저장합니다."""
    path = os.path.join(RFP_DIR, "%s-%s.json" % (kind, re.sub(r"[^\w-]", "_", item["id"])))
    files = pick_files(item.get("files") or [])
    if not files:
        return path, "skip"
    sig = signature(files)
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                saved = json.load(f)
            # 같은 첨부파일 목록이고, 접속 문제로 통째로 실패한 기록이 아니면 다시 받지 않습니다.
            network_only = not any(r.get("ok") for r in saved.get("files", [])) and \
                any("내려받기 실패" in (r.get("error") or "") for r in saved.get("files", []))
            if saved.get("signature") == sig and not network_only:
                return path, "cached"
        except Exception:
            pass

    parts, results, network_failed = [], [], False
    for f in files:
        entry = {"name": f["name"], "rfp": bool(f.get("rfp")), "ok": False, "chars": 0}
        try:
            text = clean(extract_text(f["name"], download(f["url"])))
            entry.update(ok=True, chars=len(text))
            parts.append("===== 첨부파일: %s =====\n%s" % (f["name"], text))
        except NetworkError as e:
            entry["error"] = str(e)[:200]
            network_failed = True
        except Exception as e:
            entry["error"] = str(e)[:200]
        results.append(entry)

    if network_failed and not parts:
        # 접속 문제로 하나도 못 받았으면 저장하지 않습니다 -> 다음 실행 때 다시 시도
        if os.path.exists(path):
            os.remove(path)
        raise NetworkError(results[0].get("error", "내려받기 실패"))

    full = "\n\n".join(parts)
    payload = {
        "id": item["id"],
        "kind": kind,
        "signature": sig,
        "extracted_at": datetime.now(KST).strftime("%Y-%m-%d %H:%M"),
        "files": results,
        "total_chars": len(full),
        "truncated": len(full) > MAX_TEXT_CHARS,
        "text": full[:MAX_TEXT_CHARS],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    ok = sum(1 for r in results if r["ok"])
    return path, "ok %d/%d (%d자)" % (ok, len(results), len(full))


def load_items(file_name, list_name):
    try:
        with open(os.path.join(DATA_DIR, file_name), encoding="utf-8") as f:
            return json.load(f).get(list_name) or []
    except Exception:
        return []


def main():
    os.makedirs(RFP_DIR, exist_ok=True)
    targets = [("bid", n) for n in load_items("notices.json", "notices")] + \
              [("spec", s) for s in load_items("prespecs.json", "prespecs")]

    # 지워도 되는지 판단하려고, 현재 목록에 있는 공고의 파일 이름을 먼저 모두 적어 둡니다.
    keep = {"%s-%s.json" % (kind, re.sub(r"[^\w-]", "_", item["id"])) for kind, item in targets}
    counts = {}
    started = time.time()

    network_failures = [0]

    def run(kind, item):
        if time.time() - started > TIME_BUDGET_SEC:
            return "deferred"            # 시간 초과: 다음 실행 때 이어서 합니다
        if network_failures[0] >= MAX_NETWORK_FAILURES:
            return "deferred"            # 나라장터 서버 불통: 다음 실행 때 이어서 합니다
        try:
            return process(kind, item)[1]
        except NetworkError as e:
            network_failures[0] += 1
            return "network %s" % e
        except Exception as e:           # 예상 못 한 오류도 이 공고만 건너뜁니다
            return "error %s" % e

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(run, kind, item): (kind, item) for kind, item in targets}
        for future in as_completed(futures):
            kind, item = futures[future]
            result = future.result()
            key = result.split(" ")[0]
            counts[key] = counts.get(key, 0) + 1
            if key not in ("cached", "skip", "deferred"):
                log("%s %s: %s" % (kind, item.get("id"), result))

    # 목록에서 빠진 공고의 추출본은 지웁니다.
    removed = 0
    for name in os.listdir(RFP_DIR):
        if name.endswith(".json") and name not in keep:
            os.remove(os.path.join(RFP_DIR, name))
            removed += 1
    log("완료: %s, 정리 %d건" % (counts, removed))
    if network_failures[0] >= MAX_NETWORK_FAILURES:
        log("※ 나라장터 첨부파일 서버 접속이 계속 실패해 중단했습니다. 다음 실행 때 이어서 받습니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
