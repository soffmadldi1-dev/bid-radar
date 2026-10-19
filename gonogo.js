/* =========================================================================
   🧭 Go / No-Go 판단 프롬프트
   -------------------------------------------------------------------------
   관심 있는 공고를 발견했을 때만 쓰는 도구입니다. (매일 자동으로 돌지 않습니다)
   1) 제안요청서·공고문 내용을 붙여넣거나 파일을 올립니다.
      - HWP·HWPX·TXT: 이 브라우저에서 글자를 뽑아 입력란에 채워 줍니다. (서버로 보내지 않음)
      - PDF: 글자를 뽑지 않고, claude.ai 채팅에 파일을 직접 첨부하도록 안내합니다.
   2) [📋 프롬프트 + 내용 복사] -> claude.ai 새 채팅에 붙여넣기 -> 보내기
      또는 [📋 프롬프트만 복사] -> claude.ai 채팅에 파일을 직접 첨부하고 함께 보내기
   3) 내 Claude 요금제 안에서 분석합니다. (API 키·추가 비용 없음)

   index.html 의 전역 함수(escapeHtml, formatBudget)를 함께 씁니다.
   ========================================================================= */

(function () {
  "use strict";

  /* ---------- 0) 설정값 ---------- */
  var JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
  var CFB_URL = "https://cdn.jsdelivr.net/npm/cfb@1.2.2/dist/cfb.min.js";
  var CLAUDE_NEW_CHAT = "https://claude.ai/new";
  var MAX_INPUT_CHARS = 150000;          // 입력란 글자 상한 (채팅에 한 번에 넣기 좋은 분량)

  var PROFILE_KEY = "bidRadar.profile.v1";
  var OLD_SETTINGS_KEY = "bidRadar.ai.v1";   // 예전 API 방식 설정 (키는 지우고 회사 프로필만 옮깁니다)
  var OLD_BRIEFS_KEY = "bidRadar.briefs.v1";

  /* ---------- 1) 지시문: 분석 기준 + 출력 형식 ---------- */
  var RULES = [
    "당신은 공공조달(나라장터) 용역 입찰의 참여 여부(Go/No-Go)를 판단해 주는 시니어 제안 컨설턴트입니다.",
    "아래 공고 정보와 첨부 원문(제안요청서·과업지시서·공고문)만 근거로, 바쁜 실무자가 3분 안에 결정할 수 있는 브리프를 작성해 주세요.",
    "",
    "작성 원칙",
    "- 원문에 근거가 있는 내용만 사실로 씁니다. 원문에 없으면 추정이라고 밝히거나 '확인 필요'에 넣습니다.",
    "- 한 항목은 한 줄(60자 안팎)로 짧게 씁니다. 서론·맺음말·장황한 설명은 쓰지 않습니다.",
    "- 투입 인력(M/M)은 과업 범위·기간·산출물·상주 조건으로 추정하고, 산정 근거를 한 줄로 덧붙입니다.",
    "- 수익성은 배정예산(또는 기초금액)과 추정 공수를 비교해 평가합니다. 예산이 없으면 그 사실을 밝힙니다.",
    "- 회사 프로필이 주어지면 자격 충족 여부와 강점을 Go/No-Go에 반영합니다. 없으면 일반적인 중소 교육·컨설팅 기업 기준으로 판단합니다.",
    "- 자료가 공고 정보뿐이면 판단 근거가 제한적이라는 점을 추천 근거에 밝힙니다.",
    "- 아래 [출력 형식]을 그대로 따르고, 한국어 짧은 불릿으로만 답합니다."
  ].join("\n");

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


  /* ---------- 2) 브라우저 저장소 (회사 프로필만 저장) ---------- */
  function getProfile() {
    try {
      var profile = localStorage.getItem(PROFILE_KEY);
      if (profile !== null) return profile;
      // 예전 API 방식에서 저장한 회사 프로필이 있으면 옮겨 오고, API 키 등 나머지는 지웁니다.
      var old = JSON.parse(localStorage.getItem(OLD_SETTINGS_KEY) || "null");
      profile = (old && old.profile) || "";
      localStorage.setItem(PROFILE_KEY, profile);
      localStorage.removeItem(OLD_SETTINGS_KEY);
      localStorage.removeItem(OLD_BRIEFS_KEY);
      return profile;
    } catch (e) {
      return "";
    }
  }
  function saveProfile(profile) {
    try { localStorage.setItem(PROFILE_KEY, profile); return true; } catch (e) { return false; }
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

  /* ---------- 3) 올린 파일에서 글자 뽑기 (HWP·HWPX·TXT) ---------- */
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


  /* 올린 파일 하나를 자료로 바꿉니다: {kind:'text', text} 또는 {kind:'pdf'} (PDF는 채팅에 직접 첨부) */
  async function readUpload(file) {
    var bytes = new Uint8Array(await file.arrayBuffer());
    var kind = fileKind(file.name, bytes);
    if (kind === "pdf") return { kind: "pdf", name: file.name };   // PDF는 claude.ai 채팅에 직접 첨부
    var text;
    if (kind === "hwp") text = await textFromHwp(bytes);
    else if (kind === "hwpx") text = await textFromHwpx(bytes);
    else if (kind === "txt") text = new TextDecoder("utf-8").decode(bytes);
    else throw new Error("지원하지 않는 형식입니다. HWP·HWPX·PDF·TXT 파일을 올려 주세요.");
    text = text
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1")  // 짝 잃은 특수문자 조각 제거
      .replace(/[ \t　]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length < 30) throw new Error("파일에서 글자를 거의 찾지 못했습니다. PDF로 저장해 채팅에 직접 첨부해 주세요.");
    return { kind: "text", name: file.name, text: text };
  }

  /* ---------- 4) 프롬프트 만들기 ---------- */
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


  /* mode: "full" = 지시문 + 붙여넣은 내용 / "prompt" = 지시문만 (파일은 채팅에 직접 첨부) */
  function buildPrompt(notice, content, profile, mode) {
    var parts = [RULES, "", "[출력 형식]", CHAT_TEMPLATE];
    if (notice) parts.push("", "<공고정보>", noticeFacts(notice.type, notice.item), "</공고정보>");
    if (profile) parts.push("", "<회사프로필>", profile, "</회사프로필>");
    if (mode === "full" && content) {
      parts.push("", "<원문>", content, "</원문>");
    } else if (mode === "prompt") {
      parts.push("", "원문은 이 메시지에 함께 첨부한 파일(제안요청서·과업지시서·공고문)입니다.");
    } else {
      parts.push("", "원문 없이 공고 정보만으로 판단합니다. 원문이 없어 확인할 수 없는 항목은 '확인 필요'에 적어 주세요.");
    }
    return parts.join("\n");
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
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

  /* ---------- 5) 화면 (모달 창) ---------- */
  var dialog, bodyEl;
  var notice = null;   // 관심 공고 카드에서 열었으면 { type, item }, 맨 위 버튼에서 열었으면 null

  function ensureDialog() {
    if (dialog) return;
    dialog = document.createElement("dialog");
    dialog.className = "brief-modal";
    dialog.setAttribute("aria-labelledby", "gng-title");
    dialog.innerHTML =
      '<div class="brief-head">' +
        '<div><p class="brief-kicker">🧭 Go / No-Go 판단 프롬프트</p><h3 id="gng-title"></h3></div>' +
        '<button class="brief-close" data-gng="close" aria-label="닫기">✕</button>' +
      "</div>" +
      '<div class="brief-body" id="gng-body"></div>';
    document.body.appendChild(dialog);
    bodyEl = dialog.querySelector("#gng-body");

    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) { close(); return; }        // 바깥(어두운 곳) 클릭 시 닫기
      var el = event.target.closest("[data-gng]");
      if (!el) return;
      var act = el.dataset.gng;
      if (act === "close") close();
      else if (act === "copy-full") copyPrompt(el, "full");
      else if (act === "copy-prompt") copyPrompt(el, "prompt");
      else if (act === "pick-file") bodyEl.querySelector("#gng-file").click();
      else if (act === "clear") { bodyEl.querySelector("#gng-content").value = ""; updateCount(); }
    });
    dialog.addEventListener("change", function (event) {
      if (event.target.id === "gng-file" && event.target.files[0]) handleFile(event.target.files[0]);
      if (event.target.id === "gng-profile") saveProfile(event.target.value.trim());
    });
    dialog.addEventListener("input", function (event) {
      if (event.target.id === "gng-content") updateCount();
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
  }

  function open(type, item) {
    ensureDialog();
    notice = item ? { type: type, item: item } : null;
    dialog.querySelector("#gng-title").textContent = item ? item.title : "관심 공고의 입찰 참여 여부를 판단합니다";
    render();
    if (!dialog.open) dialog.showModal();
  }

  function close() {
    if (dialog && dialog.open) dialog.close();
  }

  function render() {
    var facts = notice
      ? '<section class="brief-section"><h4>공고 정보 <small>(프롬프트에 자동 포함)</small></h4>' +
          '<p class="gng-facts">' + escapeHtml(notice.item.agency || "-") + " · 예산 " + escapeHtml(formatBudget(notice.item.budget)) +
          " · " + (notice.type === "spec" ? "의견마감 " : "마감 ") + escapeHtml(notice.item.close_date || "-") + "</p></section>"
      : "";

    bodyEl.innerHTML =
      facts +
      '<section class="brief-section">' +
        "<h4>1. 원문 내용 <small>(제안요청서·과업지시서·공고문)</small></h4>" +
        '<textarea id="gng-content" class="brief-textarea" rows="9" ' +
          'placeholder="제안요청서·공고문 내용을 붙여넣으세요. (전체를 붙여넣어도 되고, 과업 내용·참가자격·평가기준 부분만 골라 넣어도 됩니다)"></textarea>' +
        '<div class="gng-row">' +
          '<span class="brief-hint" id="gng-count">0자</span>' +
          '<button class="mini-btn" data-gng="clear">지우기</button>' +
        "</div>" +
        '<div class="brief-drop" data-gng="pick-file" tabindex="0">' +
          '<span id="gng-file-label">📎 HWP · HWPX · TXT 파일을 끌어 놓거나 눌러서 선택하면 글자를 뽑아 위 칸에 채웁니다</span>' +
        "</div>" +
        '<input type="file" id="gng-file" accept=".hwp,.hwpx,.txt,.md,.pdf" hidden />' +
        '<p class="brief-hint">PDF는 아래 <b>프롬프트만 복사</b>를 누른 뒤 claude.ai 채팅에 파일을 직접 첨부해 주세요.</p>' +
      "</section>" +

      '<section class="brief-section">' +
        '<label class="brief-field"><span>2. 우리 회사 프로필 <small>(선택 · Go/No-Go 판단에 반영 · 이 브라우저에 자동 저장)</small></span>' +
          '<textarea id="gng-profile" class="brief-textarea" rows="3" maxlength="1500" ' +
          'placeholder="예) HRD 교육기획 14년, 정부지원 인재양성 사업 운영 실적 5건, 상시 인력 4명, 직접생산확인 교육서비스 보유">' +
          escapeHtml(getProfile()) + "</textarea></label>" +
      "</section>" +

      '<p class="brief-error" id="gng-error" hidden></p>' +
      '<p class="brief-info" id="gng-info" hidden></p>' +
      '<div class="brief-actions">' +
        '<button class="brief-primary" data-gng="copy-full">📋 프롬프트 + 내용 복사</button>' +
        '<button class="mini-btn" data-gng="copy-prompt">📋 프롬프트만 복사 (파일 직접 첨부용)</button>' +
        '<a class="mini-btn" href="' + CLAUDE_NEW_CHAT + '" target="_blank" rel="noopener">claude.ai 새 채팅 열기 ↗</a>' +
      "</div>" +
      '<p class="brief-hint">복사한 내용을 claude.ai 새 채팅에 붙여넣고(Ctrl+V) 보내면 5개 항목 브리프와 Go/No-Go 의견이 나옵니다. 추가 비용 없이 내 Claude 요금제 안에서 처리됩니다.</p>';
  }

  function updateCount() {
    var len = (bodyEl.querySelector("#gng-content").value || "").length;
    bodyEl.querySelector("#gng-count").textContent = len.toLocaleString() + "자" +
      (len > MAX_INPUT_CHARS ? " · 너무 길어 앞부분 " + (MAX_INPUT_CHARS / 1000) + "천 자만 복사됩니다" : "");
  }

  async function handleFile(file) {
    var label = bodyEl.querySelector("#gng-file-label");
    var defaultLabel = "📎 HWP · HWPX · TXT 파일을 끌어 놓거나 눌러서 선택하면 글자를 뽑아 위 칸에 채웁니다";
    showMessage("", "");
    label.textContent = "⏳ " + file.name + " 읽는 중…";
    try {
      var result = await readUpload(file);
      if (result.kind === "pdf") {
        label.textContent = defaultLabel;
        showMessage("", "PDF(" + escapeHtml(file.name) + ")는 글자를 뽑지 않습니다. <b>프롬프트만 복사</b>를 누른 뒤 claude.ai 채팅에 이 파일을 직접 첨부해 주세요.");
        return;
      }
      var box = bodyEl.querySelector("#gng-content");
      var before = box.value.trim();
      box.value = (before ? before + "\n\n" : "") + "===== " + file.name + " =====\n" + result.text;
      updateCount();
      label.textContent = "✅ " + file.name + " · " + Math.round(result.text.length / 1000) + "천 자를 위 칸에 채웠습니다 (파일을 더 올리면 이어 붙입니다)";
    } catch (e) {
      label.textContent = defaultLabel;
      showMessage(e.message, "");
    }
  }

  function showMessage(error, infoHtml) {
    var err = bodyEl.querySelector("#gng-error");
    var info = bodyEl.querySelector("#gng-info");
    err.textContent = error;
    err.hidden = !error;
    info.innerHTML = infoHtml;
    info.hidden = !infoHtml;
  }

  function copyPrompt(button, mode) {
    var content = (bodyEl.querySelector("#gng-content").value || "").trim();
    var profile = (bodyEl.querySelector("#gng-profile").value || "").trim();
    saveProfile(profile);
    if (mode === "full" && content.length < 30 && !notice) {
      showMessage("원문 내용을 붙여넣거나 파일을 올려 주세요. (PDF라면 '프롬프트만 복사'를 쓰세요)", "");
      return;
    }
    var text = buildPrompt(notice, content.slice(0, MAX_INPUT_CHARS), profile, mode);
    var label = button.textContent;
    copyText(text).then(function (ok) {
      if (!ok) { showMessage("복사하지 못했습니다. 브라우저의 클립보드 권한을 확인해 주세요.", ""); return; }
      button.textContent = "✅ 복사됨";
      setTimeout(function () { button.textContent = label; }, 2000);
      showMessage("", "✅ " + (text.length >= 1000 ? Math.round(text.length / 1000) + "천" : text.length) + " 자 분량을 복사했습니다. " +
        '<a href="' + CLAUDE_NEW_CHAT + '" target="_blank" rel="noopener">claude.ai 새 채팅</a>을 열어 붙여넣기(Ctrl+V) 후 보내세요.' +
        (mode === "prompt" ? "<br />보내기 전에 제안요청서·공고문 파일을 채팅창에 첨부해 주세요." : "") +
        (mode === "full" && content.length < 30 ? "<br />원문 없이 공고 정보만으로 판단하는 프롬프트입니다." : "") +
        (text.length > 100000 ? "<br />분량이 많아 채팅창에서 첨부파일 형태로 바뀔 수 있습니다. 그대로 보내면 됩니다." : ""));
    });
  }

  /* ---------- 6) 바깥(index.html)에서 쓰는 것 ---------- */
  window.GoNoGo = {
    open: open,
    // 시험용으로만 씁니다.
    _internals: { buildPrompt: buildPrompt, readUpload: readUpload }
  };
})();
