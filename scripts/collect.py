# -*- coding: utf-8 -*-
"""
조달청 나라장터 '입찰공고정보서비스'에서 용역 공고를 수집해
config.json의 키워드로 걸러낸 뒤 data/notices.json 으로 저장하는 스크립트.

- 외부 라이브러리 없이 파이썬 기본 기능(urllib)만 사용합니다. (pip install 불필요)
- API 키(SERVICE_KEY)는 '환경변수'에서만 읽습니다. 코드에 절대 적지 않습니다.
- API가 실패하면 기존 data/notices.json 은 건드리지 않고 그대로 둡니다. (이전 데이터 유지)
"""

import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

# ---------------------------------------------------------------------------
# 0. 기본 설정값
# ---------------------------------------------------------------------------

KST = timezone(timedelta(hours=9))                                   # 한국 시간대
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # 프로젝트 최상위 폴더
CONFIG_PATH = os.path.join(ROOT, "config.json")
DATA_DIR = os.path.join(ROOT, "data")
NOTICES_PATH = os.path.join(DATA_DIR, "notices.json")   # 공고 목록 (수집 성공했을 때만 덮어씀)
STATUS_PATH = os.path.join(DATA_DIR, "status.json")     # 마지막 실행 결과 (항상 기록)

# 공공데이터포털은 서비스 주소 끝의 버전 숫자를 종종 올립니다(...Service04 -> 05 ...).
# 어떤 버전이 살아있는지 순서대로 찔러보고, 처음 성공하는 주소를 사용합니다.
SERVICE_NAMES = [
    "BidPublicInfoService04",
    "BidPublicInfoService05",
    "BidPublicInfoService03",
    "BidPublicInfoService02",
    "BidPublicInfoService",
]

# 용역 공고 목록 조회 오퍼레이션 이름 (둘 중 살아있는 쪽을 사용)
OPERATIONS = [
    "getBidPblancListInfoServc",
    "getBidPblancListInfoServcPPSSrch",
]

API_HOST = "apis.data.go.kr/1230000"
TIMEOUT = 30          # 한 번 요청할 때 최대 대기 시간(초)
ROWS_PER_PAGE = 100   # 한 페이지에 받아올 공고 수 (API 최대치)


# ---------------------------------------------------------------------------
# 1. 작은 도우미 함수들
# ---------------------------------------------------------------------------

def now_kst():
    """지금 시각(한국 시간)을 돌려줍니다."""
    return datetime.now(KST)


def log(message):
    """진행 상황을 화면(=GitHub Actions 로그)에 출력합니다."""
    print("[공고레이더] " + message, flush=True)


def load_config():
    """config.json 을 읽어옵니다. (사용자가 직접 고치는 설정 파일)"""
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    # 이름이 '_'로 시작하는 항목은 설명문이므로 무시합니다.
    return {
        "keywords": [k.strip() for k in cfg.get("keywords", []) if k.strip()],
        "exclude_keywords": [k.strip() for k in cfg.get("exclude_keywords", []) if k.strip()],
        "days_back": int(cfg.get("days_back", 7)),
        "max_pages": int(cfg.get("max_pages", 20)),
        "keep_closed_days": int(cfg.get("keep_closed_days", 1)),
    }


def squash(text):
    """비교를 쉽게 하려고 공백을 모두 지웁니다. ('시스템 구축'과 '시스템구축'을 같게 취급)"""
    return re.sub(r"\s+", "", text or "")


def to_int(value):
    """'1,234,000' 같은 문자열을 숫자로 바꿉니다. 실패하면 0."""
    if value is None:
        return 0
    digits = re.sub(r"[^0-9]", "", str(value))
    return int(digits) if digits else 0


def parse_dt(value):
    """API가 주는 날짜 문자열을 날짜형으로 바꿉니다. 형식이 제각각이라 여러 개를 시도합니다."""
    if not value:
        return None
    raw = str(value).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y%m%d%H%M%S",
                "%Y%m%d%H%M", "%Y-%m-%d", "%Y%m%d"):
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=KST)
        except ValueError:
            continue
    return None


def encode_service_key(raw_key):
    """
    공공데이터포털은 '인코딩 키'와 '디코딩 키' 두 가지를 줍니다.
      - 인코딩 키: % 기호가 들어 있음  -> 그대로 사용
      - 디코딩 키: % 기호가 없음       -> 우리가 URL용으로 변환해서 사용
    어느 쪽을 Secrets에 넣어도 동작하도록 맞춰줍니다.
    """
    key = raw_key.strip()
    if "%" in key:
        return key
    return urllib.parse.quote(key, safe="")


# ---------------------------------------------------------------------------
# 2. API 호출
# ---------------------------------------------------------------------------

def fetch_json(url):
    """주소를 호출해 JSON으로 돌려줍니다. 실패하면 예외를 던집니다."""
    request = urllib.request.Request(url, headers={"User-Agent": "bid-radar/1.0"})
    context = ssl.create_default_context()
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT, context=context) as response:
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError("HTTP %s 응답: %s" % (e.code, body[:300]))

    # 키가 잘못됐거나 서비스가 없으면 JSON이 아니라 XML 오류문이 돌아옵니다.
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        if "SERVICE_KEY_IS_NOT_REGISTERED" in body:
            raise RuntimeError(
                "API 키가 이 서비스에 등록되지 않았습니다. 공공데이터포털에서 "
                "'조달청_나라장터 입찰공고정보서비스' 활용신청이 승인됐는지 확인하세요."
            )
        if "LIMITED_NUMBER_OF_SERVICE_REQUESTS" in body:
            raise RuntimeError("오늘 API 호출 한도를 모두 썼습니다. 내일 다시 시도됩니다.")
        raise RuntimeError("JSON이 아닌 응답을 받았습니다: " + body[:300])


def build_url(service, operation, key, page, begin_dt, end_dt):
    """API 호출 주소를 조립합니다."""
    params = {
        "numOfRows": str(ROWS_PER_PAGE),
        "pageNo": str(page),
        "inqryDiv": "1",            # 1 = 공고게시일시 기준으로 조회
        "inqryBgnDt": begin_dt,     # 조회 시작 (YYYYMMDDHHMM)
        "inqryEndDt": end_dt,       # 조회 끝   (YYYYMMDDHHMM)
        "type": "json",             # JSON 형식으로 받기
    }
    query = urllib.parse.urlencode(params)
    # serviceKey는 이미 인코딩된 상태이므로 urlencode를 거치지 않고 직접 붙입니다.
    return "https://%s/%s/%s?serviceKey=%s&%s" % (API_HOST, service, operation, key, query)


def read_page(payload):
    """API 응답에서 (공고 목록, 전체 건수)를 꺼냅니다."""
    response = payload.get("response") or {}
    header = response.get("header") or {}
    code = str(header.get("resultCode", ""))
    if code not in ("00", "0", ""):
        raise RuntimeError("API 오류 코드 %s: %s" % (code, header.get("resultMsg", "")))

    body = response.get("body") or {}
    items = body.get("items")
    if isinstance(items, dict):        # 결과가 1건이면 목록이 아니라 딕셔너리로 올 때가 있습니다.
        items = items.get("item", [])
    if items is None:
        items = []
    if isinstance(items, dict):
        items = [items]
    return items, to_int(body.get("totalCount"))


def collect_raw(key, days_back, max_pages):
    """살아있는 API 주소를 찾아 최근 공고를 모두 받아옵니다."""
    end = now_kst()
    begin = end - timedelta(days=days_back)
    begin_dt = begin.strftime("%Y%m%d%H%M")
    end_dt = end.strftime("%Y%m%d%H%M")

    last_error = None
    for service in SERVICE_NAMES:
        for operation in OPERATIONS:
            try:
                first_url = build_url(service, operation, key, 1, begin_dt, end_dt)
                items, total = read_page(fetch_json(first_url))
            except Exception as e:     # 이 주소는 안 되는구나 -> 다음 후보로
                last_error = "%s/%s -> %s" % (service, operation, e)
                continue

            log("사용할 API 주소: %s/%s (조회기간 전체 %d건)" % (service, operation, total))
            collected = list(items)

            # 2페이지부터 반복해서 받아옵니다.
            total_pages = max(1, (total + ROWS_PER_PAGE - 1) // ROWS_PER_PAGE)
            last_page = min(total_pages, max_pages)
            for page in range(2, last_page + 1):
                url = build_url(service, operation, key, page, begin_dt, end_dt)
                page_items, _ = read_page(fetch_json(url))
                if not page_items:
                    break
                collected.extend(page_items)
                log("  %d/%d 페이지 수신 (누적 %d건)" % (page, last_page, len(collected)))

            return collected, "%s/%s" % (service, operation)

    raise RuntimeError("모든 API 주소 후보가 실패했습니다. 마지막 오류: " + str(last_error))


# ---------------------------------------------------------------------------
# 3. 걸러내기 / 다듬기
# ---------------------------------------------------------------------------

def pick(item, *names):
    """API 항목에서 이름이 조금씩 다를 수 있는 값을 순서대로 찾아옵니다."""
    for name in names:
        value = item.get(name)
        if value not in (None, "", "null"):
            return str(value).strip()
    return ""


def shape(item):
    """API가 준 한 건을 우리가 쓰기 좋은 형태로 다듬습니다."""
    title = pick(item, "bidNtceNm")
    notice_no = pick(item, "bidNtceNo")
    order = pick(item, "bidNtceOrd")
    close_dt = parse_dt(pick(item, "bidClseDt", "opengDt", "bidBeginDt"))
    notice_dt = parse_dt(pick(item, "bidNtceDt", "rgstDt"))
    budget = to_int(pick(item, "asignBdgtAmt")) or to_int(pick(item, "presmptPrce"))

    link = pick(item, "bidNtceDtlUrl", "bidNtceUrl")
    if not link and notice_no:
        # 원문 링크가 비어 있으면 나라장터 검색 화면 주소로 대신합니다.
        link = "https://www.g2b.go.kr/?bidno=" + urllib.parse.quote(notice_no)

    return {
        "id": "%s-%s" % (notice_no, order or "00"),
        "title": title,
        "agency": pick(item, "ntceInsttNm", "dminsttNm"),         # 공고기관
        "demand_agency": pick(item, "dminsttNm", "ntceInsttNm"),  # 수요기관
        "budget": budget,
        "notice_no": notice_no,
        "notice_date": notice_dt.strftime("%Y-%m-%d %H:%M") if notice_dt else "",
        "close_date": close_dt.strftime("%Y-%m-%d %H:%M") if close_dt else "",
        "close_ts": int(close_dt.timestamp()) if close_dt else 0,
        "contract_method": pick(item, "cntrctCnclsMthdNm"),       # 계약체결방법
        "link": link,
        "matched": [],   # 아래 filter_notices 에서 채웁니다.
    }


def filter_notices(raw_items, cfg):
    """키워드에 걸리고 제외어에 안 걸리는 공고만 남깁니다."""
    squashed_keywords = [(k, squash(k)) for k in cfg["keywords"]]
    squashed_excludes = [squash(k) for k in cfg["exclude_keywords"]]

    results = {}
    for item in raw_items:
        notice = shape(item)
        if not notice["title"]:
            continue

        haystack = squash(notice["title"])

        # (1) 제외어가 하나라도 들어있으면 버립니다.
        if any(bad and bad in haystack for bad in squashed_excludes):
            continue

        # (2) 키워드가 하나 이상 들어있어야 남깁니다.
        matched = [word for word, packed in squashed_keywords if packed and packed in haystack]
        if not matched:
            continue

        notice["matched"] = matched
        results[notice["id"]] = notice   # 같은 공고가 여러 번 오면 하나로 합칩니다.

    return list(results.values())


def drop_old(notices, keep_closed_days):
    """마감이 너무 오래 지난 공고는 목록에서 뺍니다."""
    if keep_closed_days < 0:
        return notices
    cutoff = (now_kst() - timedelta(days=keep_closed_days)).timestamp()
    return [n for n in notices if n["close_ts"] == 0 or n["close_ts"] >= cutoff]


# ---------------------------------------------------------------------------
# 4. 저장
# ---------------------------------------------------------------------------

def write_json(path, payload):
    """보기 좋은 형태(한글 그대로)로 JSON 파일을 저장합니다."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")


def write_status(ok, message, count=None, endpoint=""):
    """실행 결과를 남깁니다. 성공/실패와 무관하게 항상 기록합니다."""
    write_json(STATUS_PATH, {
        "ok": ok,
        "message": message,
        "count": count,
        "endpoint": endpoint,
        "checked_at": now_kst().strftime("%Y-%m-%d %H:%M:%S"),
    })


# ---------------------------------------------------------------------------
# 5. 메인
# ---------------------------------------------------------------------------

def main():
    # API 키는 오직 환경변수에서만 읽습니다. (GitHub Secrets -> 워크플로 -> 환경변수)
    raw_key = os.environ.get("SERVICE_KEY", "").strip()
    if not raw_key:
        write_status(False, "SERVICE_KEY 환경변수가 비어 있습니다. GitHub Secrets에 SERVICE_KEY를 등록하세요.")
        log("실패: SERVICE_KEY 가 없습니다.")
        return 0   # 여기서 멈춰도 기존 notices.json 은 그대로 보존됩니다.

    # config.json 을 잘못 고치면(쉼표 빠짐 등) 여기서 걸립니다. 원인을 한국어로 알려줍니다.
    try:
        cfg = load_config()
    except Exception as e:
        write_status(False, "config.json 을 읽지 못했습니다. 쉼표(,)나 큰따옴표(\")가 빠지지 "
                            "않았는지 확인하세요. 상세: %s" % e)
        log("실패: config.json 오류 - %s" % e)
        return 0

    log("키워드 %s / 제외어 %s / 최근 %d일" % (cfg["keywords"], cfg["exclude_keywords"], cfg["days_back"]))

    if not cfg["keywords"]:
        write_status(False, "config.json 의 keywords 가 비어 있습니다. 키워드를 1개 이상 넣어주세요.")
        log("실패: 키워드가 비어 있습니다.")
        return 0

    try:
        raw_items, endpoint = collect_raw(encode_service_key(raw_key), cfg["days_back"], cfg["max_pages"])
    except Exception as e:
        # 실패 시: notices.json 을 절대 건드리지 않습니다 -> 어제 데이터가 그대로 보입니다.
        write_status(False, str(e))
        log("실패: %s" % e)
        log("이전 data/notices.json 을 그대로 유지합니다.")
        return 0

    notices = drop_old(filter_notices(raw_items, cfg), cfg["keep_closed_days"])

    # 마감 임박순 정렬: 마감일이 빠른 순서, 마감일이 없는 건 맨 뒤로.
    far_future = 9999999999
    notices.sort(key=lambda n: (n["close_ts"] or far_future, n["title"]))

    write_json(NOTICES_PATH, {
        "updated_at": now_kst().strftime("%Y-%m-%d %H:%M:%S"),
        "keywords": cfg["keywords"],
        "exclude_keywords": cfg["exclude_keywords"],
        "total_fetched": len(raw_items),
        "count": len(notices),
        "notices": notices,
    })
    write_status(True, "정상 수집", count=len(notices), endpoint=endpoint)
    log("성공: 전체 %d건 중 키워드 일치 %d건 저장" % (len(raw_items), len(notices)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
