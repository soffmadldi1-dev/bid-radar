# -*- coding: utf-8 -*-
"""
조달청 나라장터에서 용역 '입찰공고'와 '사전규격'을 수집해
config.json의 키워드로 걸러낸 뒤 data/ 폴더에 저장하는 스크립트.

  - 입찰공고  -> data/notices.json   (입찰공고정보서비스)
  - 사전규격  -> data/prespecs.json  (사전규격정보서비스, 본공고 전에 미리 공개되는 규격안)

- 외부 라이브러리 없이 파이썬 기본 기능(urllib)만 사용합니다. (pip install 불필요)
- API 키(SERVICE_KEY)는 '환경변수'에서만 읽습니다. 코드에 절대 적지 않습니다.
- API가 실패하면 기존 data/*.json 은 건드리지 않고 그대로 둡니다. (이전 데이터 유지)
- 지난번 목록과 비교해 '처음 발견한 시각(first_seen)'을 기록합니다. 화면의 NEW 표시에 씁니다.
"""

import json
import os
import re
import socket
import ssl
import sys
import time
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
NOTICES_PATH = os.path.join(DATA_DIR, "notices.json")   # 입찰공고 목록 (수집 성공했을 때만 덮어씀)
PRESPECS_PATH = os.path.join(DATA_DIR, "prespecs.json") # 사전규격 목록 (수집 성공했을 때만 덮어씀)
STATUS_PATH = os.path.join(DATA_DIR, "status.json")     # 마지막 실행 결과 (항상 기록)

# 공공데이터포털 개발계정 화면의 실제 End Point는 중간에 'ad/' 경로가 들어갑니다.
#   예) https://apis.data.go.kr/1230000/ad/BidPublicInfoService
# 또한 서비스 주소 끝의 버전 숫자를 종종 올립니다(...Service04 -> 05 ...).
# 어떤 조합이 살아있는지 순서대로 찔러보고, 처음 성공하는 주소를 사용합니다.
SERVICE_NAMES = [
    "ad/BidPublicInfoService",
    "ad/BidPublicInfoService04",
    "ad/BidPublicInfoService05",
    "ad/BidPublicInfoService03",
    "ad/BidPublicInfoService02",
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

# 사전규격정보서비스 (공공데이터포털 End Point: .../1230000/ao/HrcspSsstndrdInfoService)
SPEC_SERVICE_NAMES = ["ao/HrcspSsstndrdInfoService"]
SPEC_OPERATIONS = [
    "getPublicPrcureThngInfoServc",          # 용역 사전규격 목록
    "getPublicPrcureThngInfoServcPPSSrch",
]

API_HOST = "apis.data.go.kr/1230000"
TIMEOUT = 30          # 한 번 요청할 때 최대 대기 시간(초)
RETRY_WAITS = [5, 15, 30]   # 네트워크 오류 시 몇 초 쉬고 다시 시도할지 (최대 3번 재시도)
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
        "prespec_enabled": bool(cfg.get("prespec_enabled", True)),
        "prespec_days_back": int(cfg.get("prespec_days_back", 14)),
        "prespec_keep_days": int(cfg.get("prespec_keep_days", 30)),
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


def fmt_dt(dt):
    """날짜형을 화면용 글자로 바꿉니다. 없으면 빈 칸."""
    return dt.strftime("%Y-%m-%d %H:%M") if dt else ""


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

class NetworkError(RuntimeError):
    """서버 접속 자체가 안 될 때(시간 초과, 연결 끊김 등) 쓰는 오류. 주소가 틀린 것과 구분합니다."""


def open_url(url):
    """주소를 한 번 호출해 응답 본문을 돌려줍니다."""
    request = urllib.request.Request(url, headers={"User-Agent": "bid-radar/1.0"})
    context = ssl.create_default_context()
    with urllib.request.urlopen(request, timeout=TIMEOUT, context=context) as response:
        return response.read().decode("utf-8", errors="replace")


def fetch_json(url):
    """주소를 호출해 JSON으로 돌려줍니다. 실패하면 예외를 던집니다.
    공공데이터포털 서버가 순간적으로 응답이 늦을 때가 있어서,
    접속 오류(시간 초과 등)는 잠시 쉬었다가 다시 시도합니다."""
    for attempt in range(len(RETRY_WAITS) + 1):
        try:
            body = open_url(url)
            break
        except urllib.error.HTTPError as e:
            if e.code < 500:   # 4xx = 주소/키 문제 -> 다시 해도 소용없음
                body = e.read().decode("utf-8", errors="replace")
                raise RuntimeError("HTTP %s 응답: %s" % (e.code, body[:300]))
            error = "HTTP %s 서버 오류" % e.code
        except (urllib.error.URLError, socket.timeout, ConnectionError, ssl.SSLError) as e:
            error = str(e)

        if attempt == len(RETRY_WAITS):
            raise NetworkError("API 서버 접속 실패(%d회 시도): %s" % (attempt + 1, error))
        wait = RETRY_WAITS[attempt]
        log("  접속 오류(%s) - %d초 후 다시 시도합니다 (%d/%d)" % (error, wait, attempt + 1, len(RETRY_WAITS)))
        time.sleep(wait)

    # 키가 잘못됐거나 서비스가 없으면 JSON이 아니라 XML 오류문이 돌아옵니다.
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        if "SERVICE_KEY_IS_NOT_REGISTERED" in body:
            raise RuntimeError(
                "API 키가 이 서비스에 등록되지 않았습니다. 공공데이터포털에서 "
                "해당 서비스(입찰공고정보서비스 / 사전규격정보서비스) 활용신청이 승인됐는지 확인하세요."
            )
        if "LIMITED_NUMBER_OF_SERVICE_REQUESTS" in body:
            raise RuntimeError("오늘 API 호출 한도를 모두 썼습니다. 내일 다시 시도됩니다.")
        raise RuntimeError("JSON이 아닌 응답을 받았습니다: " + body[:300])


def build_url(service, operation, key, page, begin_dt, end_dt):
    """API 호출 주소를 조립합니다."""
    params = {
        "numOfRows": str(ROWS_PER_PAGE),
        "pageNo": str(page),
        "inqryDiv": "1",            # 1 = 게시(등록)일시 기준으로 조회
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


def collect_raw(key, days_back, max_pages, services, operations):
    """살아있는 API 주소를 찾아 최근 자료를 모두 받아옵니다."""
    end = now_kst()
    begin = end - timedelta(days=days_back)
    begin_dt = begin.strftime("%Y%m%d%H%M")
    end_dt = end.strftime("%Y%m%d%H%M")

    last_error = None
    for service in services:
        for operation in operations:
            try:
                first_url = build_url(service, operation, key, 1, begin_dt, end_dt)
                items, total = read_page(fetch_json(first_url))
            except NetworkError:       # 서버 접속 자체가 안 되면 다른 주소를 찔러봐도 소용없습니다.
                raise
            except Exception as e:     # 이 주소는 안 되는구나 -> 다음 후보로
                last_error = "%s/%s -> %s" % (service, operation, e)
                continue

            log("사용할 API 주소: %s/%s (조회기간 전체 %d건)" % (service, operation, total))
            collected = list(items)

            # 2페이지부터 반복해서 받아옵니다.
            total_pages = max(1, (total + ROWS_PER_PAGE - 1) // ROWS_PER_PAGE)
            last_page = min(total_pages, max_pages)
            if total_pages > max_pages:
                log("  ※ 전체 %d페이지 중 %d페이지까지만 읽습니다. config.json 의 max_pages 를 늘리세요."
                    % (total_pages, max_pages))
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


# 기관 이름으로 지역을 추정합니다. (API에 '지역' 칸이 따로 없어서 이름에 든 지명을 봅니다)
# 위에서부터 차례로 확인하므로, '경기도 광주시'는 광주가 아니라 경기로 잡힙니다.
REGION_RULES = [
    ("경기", ["경기", "수원", "성남", "고양", "용인", "부천", "안산", "안양", "화성시", "평택", "의정부",
             "시흥", "파주", "김포", "광명", "이천", "하남", "오산", "군포", "남양주", "양주", "구리",
             "포천", "안성", "여주", "의왕", "과천", "동두천", "가평", "양평", "연천"]),
    ("강원", ["강원", "춘천", "원주", "강릉", "속초", "동해", "삼척", "태백", "평창", "정선", "홍천"]),
    ("충북", ["충청북도", "충북", "청주", "충주", "제천", "음성", "진천", "괴산", "옥천", "영동", "단양"]),
    ("충남", ["충청남도", "충남", "천안", "아산", "서산", "당진", "공주", "보령", "논산", "계룡", "홍성", "예산", "태안", "부여", "서천"]),
    ("전북", ["전북", "전라북도", "전주", "군산", "익산", "정읍", "남원", "김제", "완주", "부안", "고창"]),
    ("전남", ["전남", "전라남도", "목포", "여수", "순천", "나주", "광양", "무안", "해남", "완도", "담양", "영암", "영광",
             "장성", "화순", "고흥", "보성", "강진", "장흥", "진도", "신안", "함평", "곡성", "구례"]),
    ("경북", ["경북", "경상북도", "포항", "경주", "구미", "안동", "김천", "영주", "영천", "상주", "문경", "경산", "칠곡", "울진"]),
    ("경남", ["경남", "경상남도", "창원", "김해", "진주", "양산", "거제", "통영", "사천", "밀양", "함안", "거창"]),
    ("제주", ["제주", "서귀포"]),
    ("서울", ["서울"]),
    ("부산", ["부산"]),
    ("대구", ["대구"]),
    ("인천", ["인천"]),
    ("광주", ["광주"]),
    ("대전", ["대전", "한밭"]),
    ("울산", ["울산"]),
    ("세종", ["세종특별자치시", "세종시"]),
]
REGION_ETC = "전국·기타"


def guess_region(*names):
    """수요기관 -> 공고기관 순서로 이름을 보고 지역을 추정합니다. 못 찾으면 '전국·기타'."""
    for name in names:
        packed = squash(name)
        if not packed:
            continue
        for region, words in REGION_RULES:
            if any(word in packed for word in words):
                return region
    return REGION_ETC


# 첨부파일 이름에 이 단어가 있으면 '제안요청서 계열'로 보고 화면 맨 앞에 강조합니다.
PROPOSAL_DOC_WORDS = ["제안요청", "과업지시", "과업내용", "과업설명", "rfp", "제안서작성", "평가기준"]


def is_proposal_doc(file_name):
    packed = squash(file_name).lower()
    return any(word in packed for word in PROPOSAL_DOC_WORDS)


def collect_files(item, url_field, name_field, count):
    """ntceSpecDocUrl1~10 처럼 번호가 붙은 첨부파일 칸을 모아 목록으로 만듭니다."""
    files = []
    for i in range(1, count + 1):
        url = pick(item, "%s%d" % (url_field, i))
        if not url.startswith("http"):
            continue
        name = pick(item, "%s%d" % (name_field, i)) if name_field else ""
        name = name or "첨부파일 %d" % i
        files.append({"name": name, "url": url, "rfp": is_proposal_doc(name)})
    # 제안요청서 계열을 앞으로 보냅니다.
    files.sort(key=lambda f: not f["rfp"])
    return files


def shape_bid(item):
    """입찰공고 한 건을 우리가 쓰기 좋은 형태로 다듬습니다."""
    title = pick(item, "bidNtceNm")
    notice_no = pick(item, "bidNtceNo")
    order = pick(item, "bidNtceOrd") or "000"
    close_dt = parse_dt(pick(item, "bidClseDt", "opengDt", "bidBeginDt"))
    notice_dt = parse_dt(pick(item, "bidNtceDt", "rgstDt"))
    budget = to_int(pick(item, "asignBdgtAmt")) or to_int(pick(item, "presmptPrce"))
    agency = pick(item, "ntceInsttNm", "dminsttNm")
    demand = pick(item, "dminsttNm", "ntceInsttNm")

    link = pick(item, "bidNtceDtlUrl", "bidNtceUrl")
    if not link and notice_no:
        # 원문 링크가 비어 있으면 나라장터 검색 화면 주소로 대신합니다.
        link = "https://www.g2b.go.kr/?bidno=" + urllib.parse.quote(notice_no)

    return {
        "id": notice_no,                 # 같은 공고의 변경공고(차수만 다름)는 하나로 취급합니다.
        "order": order,
        "title": title,
        "agency": agency,                # 공고기관
        "demand_agency": demand,         # 수요기관
        "region": guess_region(demand, agency),
        "budget": budget,
        "notice_no": notice_no,
        "notice_date": fmt_dt(notice_dt),
        "close_date": fmt_dt(close_dt),
        "close_ts": int(close_dt.timestamp()) if close_dt else 0,
        "contract_method": pick(item, "cntrctCnclsMthdNm"),       # 계약체결방법
        "kind": pick(item, "ntceKindNm"),                         # 등록공고 / 변경공고 / 취소공고 ...
        "renotice": pick(item, "reNtceYn") == "Y",                # 재공고 여부
        "prespec_no": pick(item, "bfSpecRgstNo"),                 # 연결된 사전규격 번호
        "link": link,
        "files": collect_files(item, "ntceSpecDocUrl", "ntceSpecFileNm", 10),
        "matched": [],   # 아래 apply_keywords 에서 채웁니다.
    }


def shape_spec(item):
    """사전규격 한 건을 다듬습니다."""
    spec_no = pick(item, "bfSpecRgstNo")
    open_dt = parse_dt(pick(item, "rcptDt", "rgstDt"))
    close_dt = parse_dt(pick(item, "opninRgstClseDt"))
    agency = pick(item, "orderInsttNm", "rlDminsttNm")
    demand = pick(item, "rlDminsttNm", "orderInsttNm")
    return {
        "id": spec_no,
        "title": pick(item, "prdctClsfcNoNm"),
        "agency": agency,                # 발주기관
        "demand_agency": demand,         # 실수요기관
        "region": guess_region(demand, agency),
        "budget": to_int(pick(item, "asignBdgtAmt")),
        "notice_no": spec_no,
        "notice_date": fmt_dt(open_dt),                           # 사전규격 공개일
        "notice_ts": int(open_dt.timestamp()) if open_dt else 0,
        "close_date": fmt_dt(close_dt),                           # 의견등록 마감일
        "close_ts": int(close_dt.timestamp()) if close_dt else 0,
        "delivery_date": fmt_dt(parse_dt(pick(item, "dlvrTmlmtDt"))),   # 납품(사업) 기한
        "officer": " ".join(x for x in [pick(item, "ofclNm"), pick(item, "ofclTelNo")] if x),
        "bid_nos": pick(item, "bidNtceNoList"),                   # 본공고가 나오면 공고번호가 들어옵니다
        "files": collect_files(item, "specDocFileUrl", None, 5),
        "matched": [],
    }


def match_keywords(title, cfg):
    """제목이 키워드에 걸리면 걸린 키워드 목록, 제외어에 걸리거나 아무것도 안 걸리면 빈 목록."""
    haystack = squash(title)
    if any(bad and squash(bad) in haystack for bad in cfg["exclude_keywords"]):
        return []
    return [word for word in cfg["keywords"] if squash(word) and squash(word) in haystack]


def apply_keywords(raw_items, shape, cfg):
    """API 원본을 다듬고, 키워드에 맞는 것만 남깁니다. 같은 번호는 최신 차수 하나만 남깁니다."""
    results = {}
    for item in raw_items:
        row = shape(item)
        if not row["title"] or not row["id"]:
            continue
        row["matched"] = match_keywords(row["title"], cfg)
        if not row["matched"]:
            continue
        old = results.get(row["id"])
        if old and to_int(old.get("order")) > to_int(row.get("order")):
            continue                     # 이미 더 최신 차수(변경공고)가 들어와 있음
        results[row["id"]] = row
    return results


# ---------------------------------------------------------------------------
# 4. 지난 목록과 합치기 (NEW 표시 + 기간이 지난 공고 유지)
# ---------------------------------------------------------------------------

def read_json(path):
    """저장된 JSON 파일을 읽습니다. 없거나 깨졌으면 None."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def previous_rows(path, list_name):
    """지난번에 저장한 목록을 {번호: 항목} 으로 돌려줍니다.
    (예전 형식은 id가 '번호-차수' 였으므로 notice_no 를 기준으로 맞춥니다)"""
    saved = read_json(path) or {}
    rows = {}
    for row in saved.get(list_name) or []:
        key = row.get("notice_no") or row.get("id")
        if key:
            rows[key] = row
    return rows


def stamp_first_seen(row, old, now):
    """처음 발견한 시각을 기록합니다. 지난 목록에 있었으면 그때 시각을 그대로 이어받습니다."""
    first_seen = old.get("first_seen") if old else ""
    if old and not first_seen:
        # 이 기능을 넣기 전에 모아둔 공고: 게시일을 발견 시각으로 간주합니다.
        first_seen = old.get("notice_date") or fmt_dt(now)
    first_seen = first_seen or fmt_dt(now)
    row["first_seen"] = first_seen
    seen_dt = parse_dt(first_seen)
    row["first_seen_ts"] = int(seen_dt.timestamp()) if seen_dt else int(now.timestamp())


def merge_with_previous(fresh, previous, cfg, keep_old):
    """이번에 받은 목록 + 지난 목록 중 아직 유효한 것.
    - 이번 조회기간(최근 N일) 밖으로 밀려났지만 아직 마감 전인 공고도 계속 보여주기 위함입니다.
    - keep_old(row) 가 True 인 지난 항목만 남깁니다."""
    now = now_kst()
    merged = {}
    for key, row in fresh.items():
        stamp_first_seen(row, previous.get(key), now)
        merged[key] = row

    for key, old in previous.items():
        if key in merged or not keep_old(old):
            continue
        old["matched"] = match_keywords(old.get("title", ""), cfg)   # 키워드를 바꿨을 수 있으니 다시 확인
        if not old["matched"]:
            continue
        old["id"] = key
        old.setdefault("files", [])
        old.setdefault("region", guess_region(old.get("demand_agency"), old.get("agency")))
        stamp_first_seen(old, old, now)
        merged[key] = old
    return list(merged.values())


def bid_still_open(keep_closed_days):
    """마감 후 keep_closed_days 일이 지나지 않은 공고만 True."""
    cutoff = (now_kst() - timedelta(days=keep_closed_days)).timestamp()
    return lambda row: row.get("close_ts", 0) == 0 or row["close_ts"] >= cutoff


def spec_still_recent(keep_days):
    """공개된 지 keep_days 일이 지나지 않은 사전규격만 True."""
    cutoff = (now_kst() - timedelta(days=keep_days)).timestamp()
    return lambda row: row.get("notice_ts", 0) >= cutoff


# ---------------------------------------------------------------------------
# 5. 저장
# ---------------------------------------------------------------------------

def write_json(path, payload):
    """보기 좋은 형태(한글 그대로)로 JSON 파일을 저장합니다."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")


def status_entry(ok, message, count=None, endpoint=""):
    return {"ok": ok, "message": message, "count": count, "endpoint": endpoint}


def write_status(bid, spec=None):
    """실행 결과를 남깁니다. 성공/실패와 무관하게 항상 기록합니다.
    맨 위 ok/message 는 입찰공고 결과, prespec 은 사전규격 결과입니다."""
    payload = dict(bid)
    payload["prespec"] = spec or status_entry(None, "실행하지 않음")
    payload["checked_at"] = now_kst().strftime("%Y-%m-%d %H:%M:%S")
    write_json(STATUS_PATH, payload)


# ---------------------------------------------------------------------------
# 6. 수집 실행
# ---------------------------------------------------------------------------

def run_bids(key, cfg):
    """입찰공고를 모아 notices.json 으로 저장합니다. 결과를 status 형태로 돌려줍니다."""
    try:
        raw_items, endpoint = collect_raw(key, cfg["days_back"], cfg["max_pages"],
                                          SERVICE_NAMES, OPERATIONS)
    except Exception as e:
        # 실패 시: notices.json 을 절대 건드리지 않습니다 -> 어제 데이터가 그대로 보입니다.
        log("입찰공고 실패: %s" % e)
        log("이전 data/notices.json 을 그대로 유지합니다.")
        return status_entry(False, str(e))

    fresh = apply_keywords(raw_items, shape_bid, cfg)
    notices = merge_with_previous(fresh, previous_rows(NOTICES_PATH, "notices"), cfg,
                                  bid_still_open(cfg["keep_closed_days"]))
    notices = [n for n in notices if bid_still_open(cfg["keep_closed_days"])(n)]

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
    log("입찰공고 성공: 전체 %d건 중 키워드 일치 %d건 (지난 목록 포함 %d건 저장)"
        % (len(raw_items), len(fresh), len(notices)))
    return status_entry(True, "정상 수집", len(notices), endpoint)


def run_prespecs(key, cfg):
    """사전규격을 모아 prespecs.json 으로 저장합니다."""
    try:
        raw_items, endpoint = collect_raw(key, cfg["prespec_days_back"], cfg["max_pages"],
                                          SPEC_SERVICE_NAMES, SPEC_OPERATIONS)
    except Exception as e:
        log("사전규격 실패: %s" % e)
        log("이전 data/prespecs.json 을 그대로 유지합니다.")
        return status_entry(False, str(e))

    fresh = apply_keywords(raw_items, shape_spec, cfg)
    keep = spec_still_recent(cfg["prespec_keep_days"])
    specs = merge_with_previous(fresh, previous_rows(PRESPECS_PATH, "prespecs"), cfg, keep)
    specs = [s for s in specs if keep(s)]
    specs.sort(key=lambda s: (-s.get("notice_ts", 0), s["title"]))   # 최근 공개 순

    write_json(PRESPECS_PATH, {
        "updated_at": now_kst().strftime("%Y-%m-%d %H:%M:%S"),
        "keywords": cfg["keywords"],
        "total_fetched": len(raw_items),
        "count": len(specs),
        "prespecs": specs,
    })
    log("사전규격 성공: 전체 %d건 중 키워드 일치 %d건 (지난 목록 포함 %d건 저장)"
        % (len(raw_items), len(fresh), len(specs)))
    return status_entry(True, "정상 수집", len(specs), endpoint)


# ---------------------------------------------------------------------------
# 7. 메인
# ---------------------------------------------------------------------------

def main():
    # API 키는 오직 환경변수에서만 읽습니다. (GitHub Secrets -> 워크플로 -> 환경변수)
    raw_key = os.environ.get("SERVICE_KEY", "").strip()
    if not raw_key:
        write_status(status_entry(False, "SERVICE_KEY 환경변수가 비어 있습니다. GitHub Secrets에 SERVICE_KEY를 등록하세요."))
        log("실패: SERVICE_KEY 가 없습니다.")
        return 0   # 여기서 멈춰도 기존 data 파일은 그대로 보존됩니다.

    # config.json 을 잘못 고치면(쉼표 빠짐 등) 여기서 걸립니다. 원인을 한국어로 알려줍니다.
    try:
        cfg = load_config()
    except Exception as e:
        write_status(status_entry(False, "config.json 을 읽지 못했습니다. 쉼표(,)나 큰따옴표(\")가 빠지지 "
                                         "않았는지 확인하세요. 상세: %s" % e))
        log("실패: config.json 오류 - %s" % e)
        return 0

    log("키워드 %s / 제외어 %s / 입찰공고 최근 %d일 / 사전규격 최근 %d일"
        % (cfg["keywords"], cfg["exclude_keywords"], cfg["days_back"], cfg["prespec_days_back"]))

    if not cfg["keywords"]:
        write_status(status_entry(False, "config.json 의 keywords 가 비어 있습니다. 키워드를 1개 이상 넣어주세요."))
        log("실패: 키워드가 비어 있습니다.")
        return 0

    key = encode_service_key(raw_key)
    bid_status = run_bids(key, cfg)
    spec_status = run_prespecs(key, cfg) if cfg["prespec_enabled"] else status_entry(None, "사용 안 함")
    write_status(bid_status, spec_status)
    return 0


if __name__ == "__main__":
    sys.exit(main())
