/* =========================================================================
   🤖 RFP(제안요청서) AI 의사결정 브리프
   -------------------------------------------------------------------------
   흐름
   1) 매일 아침 GitHub Actions가 첨부파일 본문을 data/rfp/<bid|spec>-<번호>.json 으로 뽑아 둡니다.
      (브라우저는 나라장터 파일을 직접 못 받기 때문 - 보안 정책(CORS))
   2) 카드의 [🤖 AI 의사결정 브리프] 버튼 -> 아래 창에서 자료를 고르고 [분석 시작]
      - 자동 추출본 / 파일 직접 올리기(HWP·HWPX·PDF·TXT) / 텍스트 붙여넣기 / 공고 정보만
   3) 이 브라우저에 저장된 '내 Anthropic API 키'로 Claude를 직접 호출합니다.
      (키는 서버나 저장소로 보내지 않고 이 브라우저 localStorage에만 둡니다)
   4) 결과는 카드 형태로 보여주고, 복사·마크다운 저장을 지원합니다. 같은 공고는 다시 열면 저장본을 보여줍니다.

   index.html 의 전역 함수(escapeHtml, formatBudget, safeUrl)를 함께 씁니다.
   ========================================================================= */

(function () {
  "use strict";

  /* ---------- 0) 설정값 ---------- */
  // 공식 Anthropic SDK (버전을 고정해 두어 갑자기 바뀌지 않게 합니다)
  var SDK_URLS = [
    "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm",
    "https://esm.sh/@anthropic-ai/sdk@0.131.0"
  ];
  var JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
  var CFB_URL = "https://cdn.jsdelivr.net/npm/cfb@1.2.2/dist/cfb.min.js";

  var MODELS = {
    "claude-sonnet-5-5": { label: "Claude Sonnet 5.5 (기본 · 빠름)", input: 2, output: 10 },
    "claude-opus-5-5": { label: "Claude Opus 5.5 (정밀 · 비용 약 2배)", input: 4, output: 20 }
  };
  var DEFAULT_MODEL = "claude-sonnet-5-5";
  var MAX_INPUT_CHARS = 150000;          // 붙여넣기·업로드 글자 상한 (약 10만 토큰)
  var MAX_PDF_BYTES = 20 * 1024 * 1024;  // PDF 직접 전송 상한 (API 요청 한도 32MB 안쪽)

  var SETTINGS_KEY = "bidRadar.ai.v1";
  var BRIEFS_KEY = "bidRadar.briefs.v1";

  var VERDICTS = {
    "추진 적극 권장": "go",
    "조건부 추진": "cond",
    "입찰 비권장": "nogo"
  };

  /* ---------- 1) Claude에게 주는 지시문과 결과 형식 ---------- */
  var SYSTEM_PROMPT = [
    "당신은 공공조달(나라장터) 용역 입찰의 참여 여부(Go/No-Go)를 판단해 주는 시니어 제안 컨설턴트입니다.",
    "주어진 공고 정보와 첨부 원문(제안요청서·과업지시서·공고문)만 근거로, 바쁜 실무자가 3분 안에 결정할 수 있는 브리프를 작성합니다.",
    "",
    "작성 원칙",
    "- 원문에 근거가 있는 내용만 사실로 씁니다. 원문에 없으면 추정이라고 밝히거나 check_items(확인 필요)에 넣습니다.",
    "- 한 항목은 한 줄(60자 안팎)로 짧게 씁니다. 서론·맺음말·장황한 설명은 쓰지 않습니다.",
    "- 투입 인력(M/M)은 과업 범위·기간·산출물·상주 조건으로 추정하고, 산정 근거를 basis에 한 줄로 적습니다.",
    "- 수익성은 배정예산(또는 기초금액)과 추정 공수를 비교해 평가합니다. 예산이 없으면 그 사실을 밝힙니다.",
    "- 회사 프로필이 주어지면 자격 충족 여부와 강점을 Go/No-Go에 반영합니다. 없으면 일반적인 중소 교육·컨설팅 기업 기준으로 판단합니다.",
    "- 자료가 공고 정보뿐이면 판단 근거가 제한적이라는 점을 decision.reason 에 밝힙니다.",
    "- 모든 문장은 한국어로 씁니다."
  ].join("\n");

  var BRIEF_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "difficulty", "risks", "resources", "requirements", "decision", "check_items"],
    properties: {
      summary: {
        type: "array",
        description: "과업 핵심 요약: 사업의 진짜 목적과 주요 실행 과업. 최대 3줄.",
        items: { type: "string" }
      },
      difficulty: {
        type: "object",
        additionalProperties: false,
        required: ["level", "reason"],
        properties: {
          level: { type: "string", enum: ["상", "중", "하"], description: "기술/운영 난이도" },
          reason: { type: "string", description: "난이도 판단 사유 한 줄" }
        }
      },
      risks: {
        type: "array",
        description: "주요 위험 요소 (납기 촉박, 인력 상주 조건, 까다로운 검수, 지체상금 등)",
        items: { type: "string" }
      },
      resources: {
        type: "object",
        additionalProperties: false,
        required: ["man_month", "basis", "profitability"],
        properties: {
          man_month: { type: "string", description: "권장 투입 인력 추정치. 예: 약 6 M/M (PM 1명, 연구원 2명 × 2개월)" },
          basis: { type: "string", description: "M/M 산정 근거 한 줄" },
          profitability: { type: "string", description: "사업 예산 대비 수익성·공수 적정성 한 줄 평가" }
        }
      },
      requirements: {
        type: "object",
        additionalProperties: false,
        required: ["qualifications", "winning_points"],
        properties: {
          qualifications: {
            type: "array",
            description: "입찰 참가 필수 자격 (면허·업종, 최근 유사 실적, 투입 인력 자격증, 지역 제한 등)",
            items: { type: "string" }
          },
          winning_points: {
            type: "array",
            description: "제안서 작성 시 가장 중요한 승부처 (핵심 평가 요소)",
            items: { type: "string" }
          }
        }
      },
      decision: {
        type: "object",
        additionalProperties: false,
        required: ["verdict", "reason"],
        properties: {
          verdict: { type: "string", enum: ["추진 적극 권장", "조건부 추진", "입찰 비권장"] },
          reason: { type: "string", description: "추천 근거 1문장" }
        }
      },
      check_items: {
        type: "array",
        description: "자료에서 확인할 수 없어 원문·발주처 확인이 필요한 항목 (없으면 빈 목록)",
        items: { type: "string" }
      }
    }
  };

  /* ---------- 2) 브라우저 저장소 ---------- */
  function readJson(key, fallback) {
    try {
      var value = JSON.parse(localStorage.getItem(key) || "null");
      return value && typeof value === "object" ? value : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  function getSettings() {
    var s = readJson(SETTINGS_KEY, {});
    return {
      apiKey: s.apiKey || "",
      model: MODELS[s.model] ? s.model : DEFAULT_MODEL,
      profile: s.profile || ""
    };
  }
  function saveSettings(s) { return writeJson(SETTINGS_KEY, s); }

  function briefKey(type, id) { return type + ":" + id; }
  function getBrief(type, id) { return readJson(BRIEFS_KEY, {})[briefKey(type, id)] || null; }
  function saveBrief(type, id, record) {
    var all = readJson(BRIEFS_KEY, {});
    all[briefKey(type, id)] = record;
    // 너무 많이 쌓이면 오래된 것부터 정리합니다 (최대 200건)
    var keys = Object.keys(all);
    if (keys.length > 200) {
      keys.sort(function (a, b) { return (all[a].created || 0) - (all[b].created || 0); })
        .slice(0, keys.length - 200).forEach(function (k) { delete all[k]; });
    }
    writeJson(BRIEFS_KEY, all);
  }

  /* ---------- 3) 외부 라이브러리 불러오기 (필요할 때만) ---------- */
  var sdkPromise = null;
  function loadSdk() {
    if (!sdkPromise) {
      sdkPromise = (async function () {
        var lastError;
        for (var i = 0; i < SDK_URLS.length; i++) {
          try {
            var mod = await import(SDK_URLS[i]);
            return mod.default || mod.Anthropic;
          } catch (e) { lastError = e; }
        }
        sdkPromise = null;
        throw new Error("Anthropic SDK를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요. (" + (lastError && lastError.message) + ")");
      })();
    }
    return sdkPromise;
  }

  var scriptPromises = {};
  function loadScript(url, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    if (!scriptPromises[url]) {
      scriptPromises[url] = new Promise(function (resolve, reject) {
        var tag = document.createElement("script");
        tag.src = url;
        tag.onload = function () { resolve(window[globalName]); };
        tag.onerror = function () {
          delete scriptPromises[url];
          reject(new Error("파일 해석 도구를 불러오지 못했습니다: " + url));
        };
        document.head.appendChild(tag);
      });
    }
    return scriptPromises[url];
  }

  /* ---------- 4) 올린 파일에서 글자 뽑기 (HWP·HWPX·TXT) / PDF는 그대로 전송 ---------- */
  function fileKind(name, bytes) {
    var b = bytes.subarray(0, 8);
    if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return "hwp";
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf";
    if (b[0] === 0x50 && b[1] === 0x4b) return "hwpx";
    var ext = (name.split(".").pop() || "").toLowerCase();
    return ext === "txt" || ext === "md" ? "txt" : ext;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("이 브라우저는 HWP 압축 해제를 지원하지 않습니다. 최신 크롬·엣지·사파리를 쓰거나 PDF로 올려 주세요.");
    }
    // HWP 압축 구역 뒤에는 쓰레기 바이트가 붙어 있는 경우가 많아, 끝에서 나는 오류는 무시하고
    // 그때까지 풀린 내용을 그대로 씁니다. (파이썬 zlib 도 같은 방식으로 뒷부분을 무시합니다)
    var reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    var chunks = [], total = 0;
    try {
      for (;;) {
        var step = await reader.read();
        if (step.done) break;
        chunks.push(step.value);
        total += step.value.length;
      }
    } catch (e) {
      if (!total) throw new Error("HWP 본문 압축을 풀지 못했습니다. PDF로 저장해 올려 주세요.");
    }
    var out = new Uint8Array(total), offset = 0;
    chunks.forEach(function (c) { out.set(c, offset); offset += c.length; });
    return out;
  }

  // HWP 문단 안 제어문자: 1칸짜리(줄바꿈 등)와 8칸짜리(표·그림 자리표시)
  var HWP_CHAR_CONTROLS = { 0: 1, 10: 1, 13: 1, 24: 1, 25: 1, 26: 1, 27: 1, 28: 1, 29: 1, 30: 1, 31: 1 };

  function hwpRecordsToText(bytes) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var pos = 0, lines = [];
    while (pos + 4 <= bytes.length) {
      var header = view.getUint32(pos, true);
      pos += 4;
      var tag = header & 0x3ff;
      var size = (header >>> 20) & 0xfff;
      if (size === 0xfff) { size = view.getUint32(pos, true); pos += 4; }
      if (tag === 67) {                       // HWPTAG_PARA_TEXT
        var out = "", i = 0, count = Math.floor(size / 2);
        while (i < count) {
          var code = view.getUint16(pos + i * 2, true);
          if (code >= 32) { out += String.fromCharCode(code); i += 1; }
          else if (HWP_CHAR_CONTROLS[code]) { if (code === 10 || code === 13) out += "\n"; i += 1; }
          else { if (code === 9) out += "\t"; i += 8; }
        }
        if (out.trim()) lines.push(out.trim());
      }
      pos += size;
    }
    return lines.join("\n");
  }

  async function textFromHwp(bytes) {
    var CFB = await loadScript(CFB_URL, "CFB");
    var doc = CFB.read(bytes, { type: "array" });
    var header = CFB.find(doc, "FileHeader");
    if (!header) throw new Error("HWP 파일 구조를 읽지 못했습니다.");
    var h = header.content;
    var flags = h[36] | (h[37] << 8) | (h[38] << 16) | (h[39] << 24);
    if (flags & 0x02) throw new Error("암호가 걸린 HWP입니다. 암호를 풀어 다시 저장하거나 PDF로 올려 주세요.");
    if (flags & 0x04) throw new Error("배포용(읽기 전용) HWP라 본문을 읽을 수 없습니다. PDF로 저장해 올려 주세요.");
    var compressed = !!(flags & 0x01);

    var sections = [];
    doc.FullPaths.forEach(function (path, i) {
      var m = /BodyText\/Section(\d+)$/i.exec(path);
      if (m) sections.push({ n: Number(m[1]), content: doc.FileIndex[i].content });
    });
    sections.sort(function (a, b) { return a.n - b.n; });
    var parts = [];
    for (var s = 0; s < sections.length; s++) {
      var raw = Uint8Array.from(sections[s].content);
      parts.push(hwpRecordsToText(compressed ? await inflateRaw(raw) : raw));
    }
    return parts.join("\n");
  }

  function decodeXml(text) {
    return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }

  async function textFromHwpx(bytes) {
    var JSZip = await loadScript(JSZIP_URL, "JSZip");
    var zip = await JSZip.loadAsync(bytes);
    var names = Object.keys(zip.files).filter(function (n) { return /^Contents\/section\d+\.xml$/i.test(n); })
      .sort(function (a, b) { return Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")); });
    if (!names.length) throw new Error("HWPX 본문을 찾지 못했습니다.");
    var lines = [];
    for (var i = 0; i < names.length; i++) {
      var xml = await zip.file(names[i]).async("string");
      (xml.match(/<hp:p[ >][\s\S]*?<\/hp:p>/g) || []).forEach(function (para) {
        var line = (para.match(/<hp:t(?: [^>]*)?>[\s\S]*?<\/hp:t>/g) || [])
          .map(function (t) { return t.replace(/<[^>]+>/g, ""); }).join("");
        line = decodeXml(line).trim();
        if (line && line !== lines[lines.length - 1]) lines.push(line);
      });
    }
    return lines.join("\n");
  }

  function base64FromBytes(bytes) {
    var chunk = 0x8000, out = "";
    for (var i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(out);
  }

  /* 올린 파일 하나를 '보낼 자료'로 바꿉니다: {kind:'text', text} 또는 {kind:'pdf', base64} */
  async function readUpload(file) {
    var bytes = new Uint8Array(await file.arrayBuffer());
    var kind = fileKind(file.name, bytes);
    if (kind === "pdf") {
      if (bytes.length > MAX_PDF_BYTES) throw new Error("PDF가 20MB를 넘습니다. 필요한 부분만 저장해 올려 주세요.");
      return { kind: "pdf", name: file.name, base64: base64FromBytes(bytes), size: bytes.length };
    }
    var text;
    if (kind === "hwp") text = await textFromHwp(bytes);
    else if (kind === "hwpx") text = await textFromHwpx(bytes);
    else if (kind === "txt") text = new TextDecoder("utf-8").decode(bytes);
    else throw new Error("지원하지 않는 형식입니다. HWP·HWPX·PDF·TXT 파일을 올려 주세요.");
    text = text
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1")  // 짝 잃은 특수문자 조각 제거
      .replace(/[ \t　]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length < 30) throw new Error("파일에서 글자를 거의 찾지 못했습니다. PDF로 저장해 올려 주세요.");
    return { kind: "text", name: file.name, text: text };
  }

  /* ---------- 5) 자동 추출본 불러오기 ---------- */
  function rfpPath(type, id) {
    return "data/rfp/" + type + "-" + String(id).replace(/[^\w-]/g, "_") + ".json";
  }
  function loadExtracted(type, id) {
    return fetch(rfpPath(type, id) + "?t=" + Date.now())
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  /* ---------- 6) Claude 호출 ---------- */
  function noticeFacts(type, item) {
    var lines = [
      "구분: " + (type === "spec" ? "사전규격(본공고 전 규격 공개)" : "입찰공고"),
      "공고명: " + (item.title || "-"),
      "공고번호: " + (item.id || "-"),
      "발주기관: " + (item.agency || "-") + (item.demand_agency && item.demand_agency !== item.agency ? " / 수요기관: " + item.demand_agency : ""),
      "배정예산: " + (item.budget ? item.budget.toLocaleString() + "원 (" + formatBudget(item.budget) + ")" : "공개 안 됨"),
      (type === "spec" ? "의견등록 마감: " : "입찰 마감: ") + (item.close_date || "-"),
      "게시일: " + (item.notice_date || "-"),
      "지역(기관명 기준 추정): " + (item.region || "-")
    ];
    if (item.contract_method) lines.push("계약방법: " + item.contract_method);
    if (item.kind) lines.push("공고 종류: " + item.kind + (item.renotice && item.kind.indexOf("재공고") === -1 ? " (재공고)" : ""));
    if (item.delivery_date) lines.push("사업(납품) 기한: " + item.delivery_date);
    if (item.files && item.files.length) {
      lines.push("첨부파일 목록: " + item.files.map(function (f) { return f.name; }).join(", "));
    }
    return lines.join("\n");
  }

  function buildContent(type, item, source, profile) {
    var blocks = [];
    var intro = "아래 공고에 대한 [RFP 3분 의사결정 브리프]를 작성해 주세요.\n\n<공고정보>\n" + noticeFacts(type, item) + "\n</공고정보>";
    if (profile) intro += "\n\n<회사프로필>\n" + profile + "\n</회사프로필>";

    if (source.kind === "pdf") {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: source.base64 },
        title: source.name
      });
      blocks.push({ type: "text", text: intro + "\n\n첨부한 PDF(" + source.name + ")가 원문입니다." });
    } else if (source.kind === "text") {
      blocks.push({ type: "text", text: intro + "\n\n<원문 자료=\"" + source.label + "\">\n" + source.text + "\n</원문>" });
    } else {
      blocks.push({ type: "text", text: intro + "\n\n원문 첨부 없이 공고 정보만으로 판단합니다. 원문이 없어 확인할 수 없는 항목은 check_items에 넣어 주세요." });
    }
    return blocks;
  }

  async function runBrief(type, item, source, settings, onProgress, signal) {
    var Anthropic = await loadSdk();
    var client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });

    var params = {
      model: settings.model,
      max_tokens: 32000,
      system: SYSTEM_PROMPT,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: BRIEF_SCHEMA } },
      // 안전 분류기가 요청을 거절하면 서버에서 다른 모델로 자동 재시도합니다.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: buildContent(type, item, source, settings.profile) }]
    };

    var received = 0;
    var send = function (body) {
      received = 0;
      var stream = client.beta.messages.stream(body, { signal: signal });
      stream.on("text", function (delta) { received += delta.length; onProgress(received); });
      return stream.finalMessage();
    };
    var message;
    try {
      message = await send(params);
    } catch (error) {
      // 자동 재시도(fallbacks) 옵션을 계정·모델이 받지 않으면 그 옵션만 빼고 한 번 더 보냅니다.
      if (error && error.status === 400 && /fallback/i.test(error.message || "")) {
        delete params.betas;
        delete params.fallbacks;
        message = await send(params);
      } else {
        throw error;
      }
    }

    if (message.stop_reason === "refusal") {
      throw new Error("Claude가 이 요청 분석을 거절했습니다(안전 정책). 자료를 바꿔 다시 시도해 주세요.");
    }
    if (message.stop_reason === "max_tokens") {
      throw new Error("응답이 길어 중간에 끊겼습니다. 다시 시도해 주세요.");
    }
    var text = message.content.filter(function (b) { return b.type === "text"; })
      .map(function (b) { return b.text; }).join("");
    var brief;
    try { brief = JSON.parse(text); } catch (e) { throw new Error("분석 결과 형식을 읽지 못했습니다. 다시 시도해 주세요."); }
    return { brief: brief, usage: message.usage || {}, model: message.model || settings.model };
  }

  function explainError(error) {
    var status = error && error.status;
    if (error && (/Abort/.test(error.name || "") || /aborted/i.test(error.message || ""))) return "분석을 취소했습니다.";
    if (status === 401) return "API 키가 올바르지 않습니다. ⚙️ AI 설정에서 키를 다시 확인해 주세요.";
    if (status === 403) return "이 API 키로는 해당 모델을 쓸 수 없습니다. 콘솔의 권한·결제 상태를 확인해 주세요.";
    if (status === 429) return "요청이 몰려 잠시 제한되었습니다. 1분 뒤 다시 시도해 주세요.";
    if (status === 400) {
      var msg = (error.message || "");
      if (/credit|balance/i.test(msg)) return "API 크레딧이 부족합니다. Anthropic 콘솔에서 결제 상태를 확인해 주세요.";
      return "요청 형식 오류입니다: " + msg.slice(0, 200);
    }
    if (status >= 500) return "Claude 서버가 일시적으로 응답하지 않습니다. 잠시 뒤 다시 시도해 주세요.";
    return (error && error.message) || "알 수 없는 오류가 발생했습니다.";
  }

  /* ---------- 7) 결과를 글로 바꾸기 (복사·저장용 마크다운) ---------- */
  function list(items) {
    return (items && items.length ? items : ["(원문 미기재)"]).map(function (x) { return "   - " + x; }).join("\n");
  }

  function toMarkdown(type, item, record) {
    var b = record.brief;
    return [
      "### [RFP 3분 의사결정 브리프] " + item.title,
      "",
      "- 발주기관: " + (item.agency || "-") + " · 예산: " + formatBudget(item.budget) + " · " +
        (type === "spec" ? "의견마감: " : "마감: ") + (item.close_date || "-"),
      "",
      "1. **과업 핵심 요약**",
      list(b.summary),
      "2. **사업 난이도 및 리스크**",
      "   - 기술/운영 난이도: **" + b.difficulty.level + "** (" + b.difficulty.reason + ")",
      "   - 주요 위험 요소:",
      list(b.risks).replace(/^ {3}- /gm, "      - "),
      "3. **투입 리소스 및 예상 공수**",
      "   - 권장 투입 인력: " + b.resources.man_month,
      "   - 산정 근거: " + b.resources.basis,
      "   - 예산 대비 수익성·공수 적정성: " + b.resources.profitability,
      "4. **필수 자격 및 핵심 준비사항 (Must-Have)**",
      "   - 입찰 참가 필수 자격:",
      list(b.requirements.qualifications).replace(/^ {3}- /gm, "      - "),
      "   - 제안서 승부처:",
      list(b.requirements.winning_points).replace(/^ {3}- /gm, "      - "),
      "5. **Go / No-Go 추천 의견**",
      "   - 최종 제안: **[" + b.decision.verdict + "]** " + b.decision.reason,
      b.check_items && b.check_items.length ? "\n> 확인 필요: " + b.check_items.join(" / ") : "",
      "",
      "---",
      "분석: " + (MODELS[record.model] ? MODELS[record.model].label.split(" (")[0] : record.model) +
        " · " + record.createdText + " · 자료: " + record.sourceLabel,
      "※ AI 분석은 참고용입니다. 최종 판단 전 원문을 꼭 확인하세요."
    ].filter(function (line) { return line !== null; }).join("\n");
  }

  /* ---------- 8) 화면 (모달 창) ---------- */
  var dialog, bodyEl, titleEl;
  var current = null;   // { type, item, extracted, upload, abort }

  function ensureDialog() {
    if (dialog) return;
    dialog = document.createElement("dialog");
    dialog.className = "brief-modal";
    dialog.setAttribute("aria-labelledby", "brief-title");
    dialog.innerHTML =
      '<div class="brief-head">' +
        '<div><p class="brief-kicker">🤖 RFP 3분 의사결정 브리프</p><h3 id="brief-title"></h3></div>' +
        '<button class="brief-close" data-brief="close" aria-label="닫기">✕</button>' +
      "</div>" +
      '<div class="brief-body" id="brief-body"></div>';
    document.body.appendChild(dialog);
    bodyEl = dialog.querySelector("#brief-body");
    titleEl = dialog.querySelector("#brief-title");

    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) { close(); return; }        // 바깥(어두운 곳) 클릭 시 닫기
      var el = event.target.closest("[data-brief]");
      if (!el) return;
      var act = el.dataset.brief;
      if (act === "close") close();
      else if (act === "start") start();
      else if (act === "cancel" && current && current.abort) current.abort.abort();
      else if (act === "redo") renderSetup();
      else if (act === "copy") copyMarkdown(el);
      else if (act === "chat-copy") copyForChat(el);
      else if (act === "download") downloadMarkdown();
      else if (act === "save-settings") saveSettingsFromForm(el);
      else if (act === "pick-file") bodyEl.querySelector("#brief-file").click();
      else if (act === "back") renderSetup();
    });
    dialog.addEventListener("change", function (event) {
      if (event.target.id === "brief-file" && event.target.files[0]) handleFile(event.target.files[0]);
      if (event.target.name === "brief-source") updateSourcePanels();
    });
    dialog.addEventListener("dragover", function (event) {
      var drop = event.target.closest(".brief-drop");
      if (drop) { event.preventDefault(); drop.classList.add("is-over"); }
    });
    dialog.addEventListener("dragleave", function (event) {
      var drop = event.target.closest(".brief-drop");
      if (drop) drop.classList.remove("is-over");
    });
    dialog.addEventListener("drop", function (event) {
      var drop = event.target.closest(".brief-drop");
      if (!drop) return;
      event.preventDefault();
      drop.classList.remove("is-over");
      if (event.dataTransfer.files[0]) handleFile(event.dataTransfer.files[0]);
    });
    dialog.addEventListener("close", function () {
      if (current && current.abort) current.abort.abort();
    });
  }

  function open(type, item) {
    ensureDialog();
    current = { type: type, item: item, extracted: undefined, upload: null, abort: null };
    titleEl.textContent = item.title;
    var saved = getBrief(type, item.id);
    if (saved) renderResult(saved);
    else renderSetup();
    if (!dialog.open) dialog.showModal();
  }

  function close() {
    if (dialog && dialog.open) dialog.close();
    if (window.onBriefChanged) window.onBriefChanged();   // 카드의 판정 표시 갱신
  }

  /* 8-1) 자료 고르기 + 설정 화면 */
  function renderSetup() {
    var s = getSettings();
    var item = current.item;
    var files = (item.files || []).map(function (f) {
      var url = safeUrl(f.url);
      return url ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(f.name) + "</a>" : "";
    }).filter(Boolean).join(" · ");

    bodyEl.innerHTML =
      '<section class="brief-section">' +
        "<h4>1. 분석할 자료</h4>" +
        '<label class="brief-option"><input type="radio" name="brief-source" value="auto" />' +
          '<span><b>📄 자동 추출본</b><small id="brief-auto-status">확인 중…</small></span></label>' +
        '<label class="brief-option"><input type="radio" name="brief-source" value="file" />' +
          "<span><b>📎 파일 직접 올리기</b><small>HWP · HWPX · PDF · TXT (스캔 PDF도 가능)</small></span></label>" +
        '<div class="brief-panel" data-panel="file">' +
          '<div class="brief-drop" data-brief="pick-file" tabindex="0">' +
            '<span id="brief-file-label">여기로 파일을 끌어 놓거나 눌러서 선택하세요</span>' +
          "</div>" +
          '<input type="file" id="brief-file" accept=".hwp,.hwpx,.pdf,.txt,.md" hidden />' +
          (files ? '<p class="brief-hint">원문 받기: ' + files + "</p>" : "") +
        "</div>" +
        '<label class="brief-option"><input type="radio" name="brief-source" value="paste" />' +
          "<span><b>✍️ 텍스트 붙여넣기</b><small>RFP에서 필요한 부분을 복사해 붙여넣기</small></span></label>" +
        '<div class="brief-panel" data-panel="paste">' +
          '<textarea id="brief-paste" class="brief-textarea" rows="7" placeholder="제안요청서·과업지시서 내용을 붙여넣으세요"></textarea>' +
        "</div>" +
        '<label class="brief-option"><input type="radio" name="brief-source" value="meta" />' +
          "<span><b>📋 공고 정보만으로</b><small>원문 없이 빠르게 1차 판단 (정확도 낮음)</small></span></label>" +
      "</section>" +

      '<details class="brief-section brief-settings"' + (s.apiKey ? "" : " open") + ">" +
        "<summary><h4>2. ⚙️ AI 설정</h4><small>[분석 시작]용 · " + (s.apiKey ? "API 키 저장됨 · " + escapeHtml(MODELS[s.model].label.split(" (")[0]) : "처음 한 번만 설정") + "</small></summary>" +
        '<label class="brief-field"><span>Anthropic API 키</span>' +
          '<input type="password" id="brief-key" autocomplete="off" placeholder="sk-ant-..." value="' + escapeHtml(s.apiKey) + '" /></label>' +
        '<p class="brief-hint">키는 이 브라우저에만 저장되고 Anthropic 외 다른 곳으로 보내지 않습니다. ' +
          '<a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">콘솔에서 키 만들기</a> · ' +
          "API는 Claude Pro 구독과 별도로, 콘솔에 미리 충전한 크레딧에서 차감됩니다. 자동 충전을 꺼 두면 충전한 금액 이상은 쓰이지 않습니다.</p>" +
        '<label class="brief-field"><span>모델</span><select id="brief-model" class="select">' +
          Object.keys(MODELS).map(function (m) {
            return '<option value="' + m + '"' + (m === s.model ? " selected" : "") + ">" + MODELS[m].label + "</option>";
          }).join("") + "</select></label>" +
        '<label class="brief-field"><span>우리 회사 프로필 <small>(선택 · Go/No-Go 판단에 반영)</small></span>' +
          '<textarea id="brief-profile" class="brief-textarea" rows="3" maxlength="1500" ' +
          'placeholder="예) HRD 교육기획 14년, 정부지원 인재양성 사업 운영 실적 5건, 상시 인력 4명, 직접생산확인 교육서비스 보유">' +
          escapeHtml(s.profile) + "</textarea></label>" +
        '<button class="mini-btn" data-brief="save-settings">설정 저장</button>' +
      "</details>" +

      '<p class="brief-error" id="brief-error" hidden></p>' +
      '<p class="brief-info" id="brief-info" hidden></p>' +
      '<div class="brief-actions">' +
        '<button class="brief-primary" data-brief="start">분석 시작</button>' +
        '<span class="brief-hint">API 키로 바로 분석 · 보통 30초~1분 · 1건 약 50~300원(콘솔 크레딧에서 차감)</span>' +
      "</div>" +
      '<div class="brief-actions brief-alt">' +
        '<button class="mini-btn" data-brief="chat-copy">📋 claude.ai용으로 복사</button>' +
        '<span class="brief-hint">API 키 없이, Claude Pro 채팅창에 붙여넣어 분석 (추가 비용 없음 · Pro 사용량에서 차감)</span>' +
      "</div>";

    setSource("auto");
    if (current.extracted === undefined) {
      loadExtracted(current.type, current.item.id).then(function (data) {
        current.extracted = data;
        showAutoStatus();
      });
    } else {
      showAutoStatus();
    }
  }

  function showAutoStatus() {
    var status = bodyEl.querySelector("#brief-auto-status");
    if (!status) return;
    var data = current.extracted;
    var radio = bodyEl.querySelector('input[value="auto"]');
    if (data && data.text) {
      var okFiles = data.files.filter(function (f) { return f.ok; });
      var failed = data.files.length - okFiles.length;
      status.textContent = okFiles.map(function (f) { return f.name; }).join(", ") + " · " +
        Math.round(data.total_chars / 1000) + "천 자" +
        (data.truncated ? " (분량이 많아 앞부분 " + Math.round(data.text.length / 1000) + "천 자만 사용)" : "") +
        (failed ? " · " + failed + "개 파일은 읽지 못함" : "");
      radio.disabled = false;
    } else {
      status.textContent = data
        ? "첨부파일을 읽지 못했습니다(" + (data.files[0] && data.files[0].error || "형식 문제") + "). 파일을 직접 올려 주세요."
        : (current.item.files && current.item.files.length
            ? "아직 추출본이 없습니다. 매일 아침 수집 때 만들어집니다. 지금은 파일을 직접 올려 주세요."
            : "이 공고에는 첨부파일이 없습니다. 공고 정보만으로 판단하거나 원문을 올려 주세요.");
      radio.disabled = true;
      if (radio.checked) setSource(current.item.files && current.item.files.length ? "file" : "meta");
    }
  }

  function setSource(value) {
    var radio = bodyEl.querySelector('input[name="brief-source"][value="' + value + '"]');
    if (radio) radio.checked = true;
    updateSourcePanels();
  }

  function selectedSource() {
    var checked = bodyEl.querySelector('input[name="brief-source"]:checked');
    return checked ? checked.value : "auto";
  }

  function updateSourcePanels() {
    var value = selectedSource();
    bodyEl.querySelectorAll(".brief-panel").forEach(function (panel) {
      panel.hidden = panel.dataset.panel !== value;
    });
  }

  async function handleFile(file) {
    var label = bodyEl.querySelector("#brief-file-label");
    setSource("file");
    showError("");
    label.textContent = "⏳ " + file.name + " 읽는 중…";
    try {
      current.upload = await readUpload(file);
      label.textContent = "✅ " + file.name + (current.upload.kind === "pdf"
        ? " (PDF 그대로 전송)"
        : " · " + Math.round(current.upload.text.length / 1000) + "천 자 추출");
    } catch (e) {
      current.upload = null;
      label.textContent = "여기로 파일을 끌어 놓거나 눌러서 선택하세요";
      showError(e.message);
    }
  }

  function readSettingsForm() {
    return {
      apiKey: (bodyEl.querySelector("#brief-key").value || "").trim(),
      model: bodyEl.querySelector("#brief-model").value,
      profile: (bodyEl.querySelector("#brief-profile").value || "").trim()
    };
  }

  function saveSettingsFromForm(button) {
    var ok = saveSettings(readSettingsForm());
    button.textContent = ok ? "저장했습니다 ✓" : "저장 실패(브라우저 저장소 차단)";
    setTimeout(function () { button.textContent = "설정 저장"; }, 1600);
  }

  function showError(message) {
    var el = bodyEl.querySelector("#brief-error");
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
  }

  /* 8-2) 분석 실행 */
  function collectSource() {
    var value = selectedSource();
    if (value === "auto") {
      var data = current.extracted;
      if (!data || !data.text) throw new Error("자동 추출본이 없습니다. 다른 자료를 골라 주세요.");
      var names = data.files.filter(function (f) { return f.ok; }).map(function (f) { return f.name; });
      return { kind: "text", text: data.text, label: names.join(", "),
               sourceLabel: names[0] + (names.length > 1 ? " 외 " + (names.length - 1) + "개" : "") + (data.truncated ? " (앞부분)" : "") };
    }
    if (value === "file") {
      if (!current.upload) throw new Error("먼저 파일을 올려 주세요.");
      var up = current.upload;
      if (up.kind === "pdf") return { kind: "pdf", base64: up.base64, name: up.name, sourceLabel: up.name };
      var cut = up.text.length > MAX_INPUT_CHARS;
      return { kind: "text", text: up.text.slice(0, MAX_INPUT_CHARS), label: up.name,
               sourceLabel: up.name + (cut ? " (앞부분 " + Math.round(MAX_INPUT_CHARS / 1000) + "천 자)" : "") };
    }
    if (value === "paste") {
      var text = (bodyEl.querySelector("#brief-paste").value || "").trim();
      if (text.length < 30) throw new Error("붙여넣은 내용이 너무 짧습니다.");
      var over = text.length > MAX_INPUT_CHARS;
      return { kind: "text", text: text.slice(0, MAX_INPUT_CHARS), label: "붙여넣은 텍스트",
               sourceLabel: "붙여넣은 텍스트" + (over ? " (앞부분)" : "") };
    }
    return { kind: "meta", sourceLabel: "공고 정보만" };
  }

  async function start() {
    var settings = readSettingsForm();
    if (!/^sk-ant-/.test(settings.apiKey)) {
      bodyEl.querySelector(".brief-settings").open = true;
      showError("Anthropic API 키(sk-ant-로 시작)를 입력해 주세요.");
      return;
    }
    saveSettings(settings);

    var source;
    try { source = collectSource(); } catch (e) { showError(e.message); return; }

    var type = current.type, item = current.item;
    current.abort = new AbortController();
    var startedAt = Date.now();
    bodyEl.innerHTML =
      '<div class="brief-loading">' +
        '<div class="brief-spinner" aria-hidden="true"></div>' +
        "<p><b>Claude가 자료를 읽고 판단하는 중입니다…</b></p>" +
        '<p class="brief-hint" id="brief-progress">준비 중</p>' +
        '<button class="mini-btn" data-brief="cancel">취소</button>' +
      "</div>";
    var progress = bodyEl.querySelector("#brief-progress");
    var received = 0;
    var tick = setInterval(function () {
      var sec = Math.round((Date.now() - startedAt) / 1000);
      progress.textContent = sec + "초 경과" + (received ? " · 결과 작성 중 (" + received.toLocaleString() + "자)" : " · 원문 검토 중");
    }, 500);

    try {
      var result = await runBrief(type, item, source, settings,
        function (n) { received = n; }, current.abort.signal);
      var now = new Date();
      var record = {
        brief: result.brief,
        model: settings.model,
        servedModel: result.model,
        usage: { input: result.usage.input_tokens || 0, output: result.usage.output_tokens || 0 },
        created: now.getTime(),
        createdText: now.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" }),
        sourceLabel: source.sourceLabel
      };
      saveBrief(type, item.id, record);
      renderResult(record);
    } catch (error) {
      renderError(explainError(error));
    } finally {
      clearInterval(tick);
      current.abort = null;
    }
  }

  function renderError(message) {
    bodyEl.innerHTML =
      '<div class="brief-loading">' +
        '<p class="brief-error">' + escapeHtml(message) + "</p>" +
        '<button class="mini-btn" data-brief="back">← 돌아가기</button>' +
      "</div>";
  }

  /* 8-3) 결과 화면 */
  function bullets(items, empty) {
    if (!items || !items.length) return '<p class="brief-muted">' + (empty || "원문 미기재") + "</p>";
    return "<ul>" + items.map(function (x) { return "<li>" + escapeHtml(x) + "</li>"; }).join("") + "</ul>";
  }

  function costText(record) {
    var price = MODELS[record.model];
    if (!price || !record.usage) return "";
    var usd = (record.usage.input * price.input + record.usage.output * price.output) / 1e6;
    return "입력 " + (record.usage.input / 1000).toFixed(1) + "천 · 출력 " + (record.usage.output / 1000).toFixed(1) +
      "천 토큰 (약 $" + usd.toFixed(3) + ")";
  }

  function renderResult(record) {
    var b = record.brief;
    var verdictCls = VERDICTS[b.decision.verdict] || "cond";
    var levelCls = { "상": "hard", "중": "mid", "하": "easy" }[b.difficulty.level] || "mid";

    bodyEl.innerHTML =
      '<div class="brief-verdict v-' + verdictCls + '">' +
        "<span>Go / No-Go</span><strong>" + escapeHtml(b.decision.verdict) + "</strong>" +
        "<p>" + escapeHtml(b.decision.reason) + "</p>" +
      "</div>" +

      '<div class="brief-grid">' +
        '<article class="brief-card brief-wide"><h5>1. 과업 핵심 요약</h5>' + bullets(b.summary) + "</article>" +

        '<article class="brief-card"><h5>2. 난이도 및 리스크</h5>' +
          '<p><span class="brief-level l-' + levelCls + '">난이도 ' + escapeHtml(b.difficulty.level) + "</span> " +
          escapeHtml(b.difficulty.reason) + "</p>" + bullets(b.risks, "특이 위험 요소 없음") + "</article>" +

        '<article class="brief-card"><h5>3. 투입 리소스 · 예상 공수</h5>' +
          '<p class="brief-mm">' + escapeHtml(b.resources.man_month) + "</p>" +
          '<p class="brief-muted">' + escapeHtml(b.resources.basis) + "</p>" +
          "<p>💰 " + escapeHtml(b.resources.profitability) + "</p></article>" +

        '<article class="brief-card brief-wide"><h5>4. 필수 자격 · 핵심 준비사항</h5>' +
          '<div class="brief-two">' +
            "<div><h6>입찰 참가 필수 자격</h6>" + bullets(b.requirements.qualifications) + "</div>" +
            "<div><h6>제안서 승부처</h6>" + bullets(b.requirements.winning_points) + "</div>" +
          "</div></article>" +

        (b.check_items && b.check_items.length
          ? '<article class="brief-card brief-wide brief-check"><h5>🔎 확인 필요</h5>' + bullets(b.check_items) + "</article>"
          : "") +
      "</div>" +

      '<div class="brief-actions">' +
        '<button class="mini-btn" data-brief="copy">📋 복사</button>' +
        '<button class="mini-btn" data-brief="download">⬇️ 마크다운 저장</button>' +
        '<button class="mini-btn" data-brief="redo">🔄 다시 분석</button>' +
      "</div>" +
      '<p class="brief-meta">' +
        escapeHtml((MODELS[record.model] ? MODELS[record.model].label.split(" (")[0] : record.model) +
          " · " + record.createdText + " · 자료: " + record.sourceLabel) +
        (costText(record) ? "<br />" + escapeHtml(costText(record)) : "") +
        "<br />※ AI 분석은 참고용입니다. 최종 판단 전 원문을 꼭 확인하세요." +
      "</p>";
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function copyMarkdown(button) {
    var record = getBrief(current.type, current.item.id);
    if (!record) return;
    copyText(toMarkdown(current.type, current.item, record)).then(function (ok) {
      button.textContent = ok ? "✅ 복사됨" : "복사 실패";
      setTimeout(function () { button.textContent = "📋 복사"; }, 1600);
    });
  }

  /* claude.ai(Pro 요금제) 채팅창에 붙여넣을 한 덩어리 지시문을 만듭니다. API 키·추가 비용 없음. */
  var CHAT_TEMPLATE = [
    "### [RFP 3분 의사결정 브리프]",
    "1. **과업 핵심 요약 (3줄 이내)**: 본 사업의 진짜 목적 및 주요 실행 과업",
    "2. **사업 난이도 및 리스크**:",
    "   - 기술/운영 난이도: 상/중/하 (사유 요약)",
    "   - 주요 위험 요소: (납기 촉박, 인력 상주 조건, 까다로운 검수 등)",
    "3. **투입 리소스 및 예상 공수**:",
    "   - 권장 투입 인력(M/M) 추정치 (산정 근거 한 줄)",
    "   - 사업 예산 대비 수익성/공수 적정성 한 줄 평가",
    "4. **필수 자격 및 핵심 준비사항 (Must-Have)**:",
    "   - 입찰 참가 필수 자격(면허, 최근 유사 실적, 상주 인력 자격증 등)",
    "   - 제안서 작성 시 가장 중요한 승부처(핵심 평가 요소)",
    "5. **Go / No-Go 추천 의견**:",
    "   - 최종 제안: [추진 적극 권장 / 조건부 추진 / 입찰 비권장] 중 택1 및 1문장 근거",
    "> 확인 필요: 자료에서 확인할 수 없는 항목"
  ].join("\n");

  function buildChatPrompt(type, item, source, profile) {
    var parts = [
      // API용 필드 이름(check_items 등)은 채팅에 맞는 말로 바꿉니다.
      SYSTEM_PROMPT.replace("check_items(확인 필요)", "'확인 필요'")
        .replace("산정 근거를 basis에 한 줄로 적습니다", "산정 근거를 한 줄로 덧붙입니다")
        .replace("decision.reason 에", "추천 근거에"),
      "- 아래 [출력 형식]을 그대로 따르고, 짧은 불릿으로만 답합니다.",
      "",
      "[출력 형식]",
      CHAT_TEMPLATE,
      "",
      "<공고정보>",
      noticeFacts(type, item),
      "</공고정보>"
    ];
    if (profile) parts.push("", "<회사프로필>", profile, "</회사프로필>");
    if (source.kind === "text") {
      parts.push("", "<원문 자료=\"" + source.label + "\">", source.text, "</원문>");
    } else if (source.kind === "pdf") {
      parts.push("", "원문은 함께 첨부한 PDF(" + source.name + ")입니다.");
    } else {
      parts.push("", "원문 첨부 없이 공고 정보만으로 판단합니다. 원문이 없어 확인할 수 없는 항목은 '확인 필요'에 적어 주세요.");
    }
    return parts.join("\n");
  }

  function showInfo(html) {
    var el = bodyEl.querySelector("#brief-info");
    if (!el) return;
    el.innerHTML = html;
    el.hidden = !html;
  }

  function copyForChat(button) {
    showError("");
    showInfo("");
    var source;
    try { source = collectSource(); } catch (e) { showError(e.message); return; }
    var profile = (bodyEl.querySelector("#brief-profile").value || "").trim();
    var text = buildChatPrompt(current.type, current.item, source, profile);
    copyText(text).then(function (ok) {
      if (!ok) { showError("복사하지 못했습니다. 브라우저의 클립보드 권한을 확인해 주세요."); return; }
      button.textContent = "✅ 복사됨";
      setTimeout(function () { button.textContent = "📋 claude.ai용으로 복사"; }, 2000);
      showInfo("✅ " + Math.round(text.length / 1000) + "천 자 분량을 복사했습니다. " +
        '<a href="https://claude.ai/new" target="_blank" rel="noopener">claude.ai 새 채팅</a>을 열어 붙여넣기(Ctrl+V) 후 보내세요.' +
        (source.kind === "pdf" ? "<br />PDF는 복사되지 않으니 채팅창에 파일을 직접 첨부해 주세요." : "") +
        (text.length > 100000 ? "<br />분량이 많아 채팅창에서 첨부파일 형태로 바뀔 수 있습니다. 그대로 보내면 됩니다." : ""));
    });
  }

  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    dialog.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    area.remove();
    return ok;
  }

  function downloadMarkdown() {
    var record = getBrief(current.type, current.item.id);
    if (!record) return;
    var blob = new Blob([toMarkdown(current.type, current.item, record)], { type: "text/markdown;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "RFP브리프_" + current.item.title.replace(/[\\/:*?"<>|]/g, "").slice(0, 40) + ".md";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  /* ---------- 9) 바깥(index.html)에서 쓰는 것 ---------- */
  window.AIBrief = {
    open: open,
    // 카드에 '저장된 판정'을 작게 보여줄 때 씁니다.
    verdictOf: function (type, id) {
      var record = getBrief(type, id);
      return record ? { verdict: record.brief.decision.verdict, cls: VERDICTS[record.brief.decision.verdict] || "cond" } : null;
    },
    // 시험용으로만 씁니다.
    _internals: { buildChatPrompt: buildChatPrompt, readUpload: readUpload, toMarkdown: toMarkdown, buildContent: buildContent, BRIEF_SCHEMA: BRIEF_SCHEMA }
  };
})();
