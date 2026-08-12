const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAppCheck } = require("firebase-admin/app-check");
const { RtcTokenBuilder, RtcRole } = require("agora-token");

initializeApp();
const db = getFirestore();

// App Check: 우리 앱(reCAPTCHA v3 검증 통과)에서 온 요청만 허용하기 위한 검증.
// 배포 초기에는 monitor 모드(false)로 두어 토큰이 정상 흐르는지 로그로 확인한 뒤,
// 확인되면 true 로 바꿔 재배포하면 무단 호출이 차단된다.
const ENFORCE_APP_CHECK = true;

// 유효한 App Check 토큰이면 true. enforce 모드에서 무효/누락이면 401 응답 후 false.
// monitor 모드에서는 항상 통과시키되 검증 결과를 로그로 남긴다.
async function requireAppCheck(req, res) {
  const token = req.header("X-Firebase-AppCheck");
  let valid = false;
  if (token) {
    try {
      await getAppCheck().verifyToken(token);
      valid = true;
    } catch (e) {
      logger.warn("App Check 토큰 검증 실패", e && e.message);
    }
  } else {
    logger.info("App Check 토큰 없음");
  }
  if (!valid && ENFORCE_APP_CHECK) {
    res.status(401).json({ error: "앱 인증이 필요합니다" });
    return false;
  }
  return true;
}

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const ADMIN_PIN = defineSecret("ADMIN_PIN");
// Agora RTC 무전(PTT) 기능용 — App Certificate는 클라이언트에 절대 노출하지 않고
// 이 서버에서만 사용해 단기 토큰을 발급한다 (firebase functions:secrets:set 으로 설정)
const AGORA_APP_ID = defineSecret("AGORA_APP_ID");
const AGORA_APP_CERTIFICATE = defineSecret("AGORA_APP_CERTIFICATE");

// GitHub Pages 배포 origin만 허용 (필요 시 여기에 추가 origin을 넣으세요)
const ALLOWED_ORIGINS = ["https://hayashiokada-stack.github.io"];

async function fetchStaffList() {
  const snap = await db.collection("staff").orderBy("name").get();
  return snap.docs.map((d) => ({ id: d.id, name: d.data().name }));
}

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // OpenAI 업로드 제한과 동일

function extensionForMimeType(mimeType) {
  const type = (mimeType || "").toLowerCase();
  if (type.includes("webm")) return "webm";
  if (type.includes("wav")) return "wav";
  if (type.includes("mp3") || type.includes("mpeg")) return "mp3";
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return "mp4";
  return "mp4";
}

// OpenAI Whisper 로 오디오를 한국어 텍스트로 전사한다 (transcribe / savePttClip 공용).
// OpenAI 호출 실패 시 예외를 던지므로 호출부에서 처리한다.
async function transcribeAudioBuffer(audioBuffer, mimeType) {
  const extension = extensionForMimeType(mimeType);
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([audioBuffer], { type: mimeType || "audio/mp4" }),
    `recording.${extension}`
  );
  formData.append("model", "whisper-1");
  formData.append("language", "ko");

  const openaiRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY.value()}` },
    body: formData,
  });

  if (!openaiRes.ok) {
    const errText = await openaiRes.text();
    logger.error("OpenAI STT 오류", errText);
    throw new Error("OpenAI STT 호출 실패");
  }

  const data = await openaiRes.json();
  return data.text || "";
}

exports.transcribe = onRequest(
  {
    secrets: [OPENAI_API_KEY],
    cors: ALLOWED_ORIGINS,
    region: "asia-northeast3",
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (req, res) => {
    if (!(await requireAppCheck(req, res))) return;
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST만 지원합니다" });
      return;
    }

    const { audioBase64, mimeType } = req.body || {};
    if (!audioBase64 || typeof audioBase64 !== "string") {
      res.status(400).json({ error: "audioBase64가 필요합니다" });
      return;
    }

    let audioBuffer;
    try {
      audioBuffer = Buffer.from(audioBase64, "base64");
    } catch (e) {
      res.status(400).json({ error: "잘못된 오디오 데이터입니다" });
      return;
    }

    if (audioBuffer.length === 0 || audioBuffer.length > MAX_AUDIO_BYTES) {
      res.status(400).json({ error: "오디오 크기가 올바르지 않습니다" });
      return;
    }

    try {
      const text = await transcribeAudioBuffer(audioBuffer, mimeType);
      res.status(200).json({ text });
    } catch (err) {
      logger.error("transcribe 처리 중 오류", err);
      res.status(502).json({ error: "음성 인식 서비스 호출에 실패했습니다" });
    }
  }
);

// --- AI 기록 생성 (care-record-fix 스킬 원칙 + 5유형별_AI프롬프트_설계.md 구조) ---
// STT 원문을 급여기록지/인수인계/보호자 안내(사고 시 사고보고서 추가)로 정리한다.
const RECORD_TYPES = ["신체활동지원", "인지활동지원", "간호처치", "영양·식사", "특이사항"];

// 사고 판정은 결정적으로(키워드) 처리한다 — LLM 판단에만 맡기면 축소·누락 위험이 있어
// care-record-fix 원칙("사고는 절대 축소·누락하지 않는다")을 서버에서 강제한다.
const INCIDENT_KEYWORDS = ["낙상", "넘어짐", "미끄러짐", "부딪힘", "상처", "출혈", "골절", "화상", "사레", "질식", "오연", "실종", "배회", "의식소실", "응급실", "119"];
function detectIncident(text) {
  return INCIDENT_KEYWORDS.some((k) => text.includes(k));
}
function detectNursingAbnormal(text) {
  const bp = text.match(/(\d{2,3})\s*\/\s*(\d{2,3})\s*mmHg/);
  if (bp) {
    const sys = parseInt(bp[1], 10);
    const dia = parseInt(bp[2], 10);
    if (sys >= 140 || sys <= 90 || dia >= 90) return true;
  }
  const temp = text.match(/([\d.]+)\s*도/);
  if (temp && parseFloat(temp[1]) >= 37.5) return true;
  return /이상반응|발열|호흡곤란|어지러움|구토/.test(text);
}

const RECORD_SYSTEM_PROMPT = `당신은 대한민국 장기요양기관에서 요양보호사·간호(조무)인력이 구술한 돌봄 기록을 정식 기록 문장으로 정리하는 어시스턴트입니다. 입력 원문은 현장에서 말한 것을 그대로 받아쓴 것입니다.

[절대 규칙]
1. 원문에 있는 사실만 사용한다. 원문에 없는 수치·횟수·증상·발언·조치를 새로 지어내지 않는다.
2. 채워야 하는 항목의 근거가 원문에 없으면 그럴듯하게 메우지 말고 "[확인 필요: 무엇]" 형태로 남긴다.
3. 의학적 단정을 쓰지 않는다("치매가 악화됨", "약을 줄여야 함" 등 금지). 관찰된 행동과 빈도 변화, 기관이 한 조치로 바꾼다.
4. 활동 나열이 아니라 상태 중심으로 쓴다. "무엇을 했다"가 아니라 "그래서 어르신이 어떻게 되었는가"가 드러나야 한다.
5. 사고·낙상·응급 정황은 절대 축소하거나 빼지 않는다.
6. 수급자명은 주어진 이름을 그대로 사용한다(내부 기록 시스템이므로 비식별하지 않는다).
7. 여러 문장이 똑같은 패턴으로 찍혀 나오지 않게 한다. 개별성이 기록의 핵심이다.

[표현 교정]
- "특이사항 없음" → 무엇이 유지되고 있는지 쓴다.
- "컨디션 안 좋음/기력 저하" → 어떤 모습을 보고 그렇게 판단했는지 쓴다.
- "잘 참여하심" → 참여 중 관찰된 기능·반응을 쓴다.
- "식사 잘하심" → 섭취량·속도·자세·기침 유무를 쓴다.
- "우울/불안해 보이심" → 말수·활동량·식사량의 변화로 쓴다.
- "보호자 이해하심" → 기관이 무엇을 하기로 했는지로 끝낸다.
- "필요시 지원함" → 실제 몇 번, 어떤 상황이었는지 쓴다(근거 없으면 [확인 필요]).

[출력]
반드시 아래 키를 가진 JSON 객체 하나만 출력한다. 마크다운·설명·코드펜스를 덧붙이지 않는다.
{
  "feeReport": "급여기록지용 문장(항목 구조화)",
  "handover": "인수인계용 문장(3~4문장)",
  "guardianMsg": "보호자 카카오톡 안내용 문장(2~3문장, 존댓말)",
  "incidentReport": "사고보고서(사고일 때만 채우고, 아니면 빈 문자열)"
}`;

const TYPE_GUIDES = {
  "신체활동지원": `[유형] 신체활동지원
- feeReport 항목: 수행시간 / 지원내용(세면·구강관리·배설·이동·체위변경 등 구체 항목) / 수급자 반응 및 상태 / 특이사항. 추측성 표현 금지, 관찰 사실만.
- handover: 다음 근무자가 이어서 확인할 것(주의 부위, 다음 케어 시점) 중심.
- guardianMsg: 따뜻하고 안심되는 톤, 의료적 우려를 유발하는 표현 지양.`,
  "인지활동지원": `[유형] 인지활동지원
- feeReport 항목: 프로그램명/활동내용 / 참여도(적극적·소극적·거부 등) / 인지·정서 반응 / 특이사항. 인지저하는 평가용어가 아닌 관찰 사실로("치매가 심해짐" X → "이름을 반복해서 물어보심" O).
- handover: 참여 거부·정서 변화·반복 질문 등 이어서 관찰할 포인트 중심.
- guardianMsg: 인지저하를 암시하는 표현 금지. 긍정적·사실 기반. 우려 변화가 있으면 "센터에서 계속 지켜보고 있다"는 안심 문구 포함, 진단성 표현은 피함.`,
  "간호처치": `[유형] 간호처치 (의료 관련 — 특히 사실 기반으로만)
- feeReport 항목: 처치내용(투약/혈압측정/상처소독 등) / 수치(원문에 명시된 것만 그대로) / 이상반응 유무 / 다음 처치 예정. 원문에 없는 수치·진단은 절대 생성 금지([확인 필요] 사용).
- handover: 투약 여부·다음 처치 시점·이상반응을 구체적 시간·수치로 명확히.
- guardianMsg: 사실대로 전달하되 과도한 불안 조성은 지양.`,
  "영양·식사": `[유형] 영양·식사
- feeReport 항목: 식사형태(일반식/다진식/유동식 등) / 섭취량(전량/절반/소량 등) / 식사 중 특이사항(사레·거부·삼킴곤란 등) / 수분섭취. 삼킴곤란·사레 등 안전 사항은 빠짐없이 포함.
- handover: 섭취량 저하·삼킴곤란 등 다음 식사 시 주의점 위주로 축약.
- guardianMsg: 섭취량은 사실대로 전달하되 안심 문구 동반. 안전 이슈가 있으면 명시하되 과도한 불안 조성 지양.`,
  "특이사항": `[유형] 특이사항
- feeReport 항목: 발생시간 / 상황내용 / 조치사항 / 경과관찰 필요 여부.
- handover: 다음 근무자가 이어서 관찰할 부분 중심으로 축약.
- guardianMsg: 경미한 특이사항은 사실 위주로 간단히 안내, 안심 문구 포함.`,
};

const INCIDENT_GUIDE = `[사고로 분류됨] 위 3종에 더해 incidentReport를 반드시 작성한다. 아래 항목을 모두 포함하고, 원문에 없는 정보는 "[확인 필요]"로 명시한다(임의로 지어내지 않는다).
- 발생일시 / 발생장소 / 사고유형(낙상·이물질·화상 등) / 사고 발생 경위(객관적 서술) / 초기 대응 조치 / 통보 여부 및 대상(가족·기관장·관할 보험사·지자체) / 재발방지대책(초안, "담당자 검토 필요" 문구 포함).
- 사고 건은 보호자 자동전송 대상이 아니므로 guardianMsg는 간결한 사실 위주로 쓴다(과도한 표현 금지).`;

function buildRecordUserPrompt({ type, text, patient, staffName, isIncident, nowLabel }) {
  const p = patient || {};
  const conditions = Array.isArray(p.conditions) && p.conditions.length ? p.conditions.join(", ") : "정보 없음";
  const lines = [
    "아래 원문을 정식 기록으로 정리하세요.",
    "",
    `[수급자] ${p.name || "확인 필요"} / ${p.age != null ? p.age + "세" : "나이 미상"} / ${p.grade || "등급 미상"}`,
    `[주요 상병] ${conditions}`,
    `[기록일시] ${nowLabel}`,
    `[작성자] ${staffName || "미상"}`,
    "",
    TYPE_GUIDES[type],
  ];
  if (isIncident) lines.push("", INCIDENT_GUIDE);
  lines.push("", "[녹음 원문]", text);
  return lines.join("\n");
}

async function generateRecordOutputs({ type, text, patient, staffName }) {
  const isIncident = type === "특이사항" && detectIncident(text);
  const requiresManualReview = type === "간호처치" && detectNursingAbnormal(text);
  const nowLabel = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

  const userPrompt = buildRecordUserPrompt({ type, text, patient, staffName, isIncident, nowLabel });

  const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY.value()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: RECORD_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!openaiRes.ok) {
    const errText = await openaiRes.text();
    logger.error("OpenAI 기록생성 오류", errText);
    throw new Error("OpenAI 기록 생성 호출 실패");
  }

  const data = await openaiRes.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    logger.error("기록생성 JSON 파싱 실패", content);
    throw new Error("기록 생성 응답 파싱 실패");
  }

  const result = {
    type,
    feeReport: typeof parsed.feeReport === "string" ? parsed.feeReport.trim() : "",
    handover: typeof parsed.handover === "string" ? parsed.handover.trim() : "",
    guardianMsg: typeof parsed.guardianMsg === "string" ? parsed.guardianMsg.trim() : "",
    isIncident,
    requiresManualReview,
  };

  // 안전 문구는 서버에서 결정적으로 강제한다(자동전송 차단은 프론트에서도 이중 처리).
  if (isIncident) {
    result.incidentReport = typeof parsed.incidentReport === "string" && parsed.incidentReport.trim()
      ? parsed.incidentReport.trim()
      : "[확인 필요] 사고보고서 항목(발생일시/발생장소/사고유형/경위/초기대응/통보대상/재발방지대책)을 담당자가 작성해야 합니다.";
    result.guardianMsg = "담당자가 직접 유선 연락 예정입니다.";
  } else if (requiresManualReview) {
    result.guardianMsg = "간호팀 확인 후 개별 연락이 필요합니다 (카카오톡 자동 전송 보류).";
  }

  return result;
}

exports.generateRecord = onRequest(
  {
    secrets: [OPENAI_API_KEY],
    cors: ALLOWED_ORIGINS,
    region: "asia-northeast3",
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async (req, res) => {
    if (!(await requireAppCheck(req, res))) return;
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST만 지원합니다" });
      return;
    }

    const { type, text, patient, staffName } = req.body || {};
    if (!RECORD_TYPES.includes(type)) {
      res.status(400).json({ error: "지원하지 않는 기록 유형입니다" });
      return;
    }
    if (!text || typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "기록 원문이 필요합니다" });
      return;
    }
    if (text.length > 5000) {
      res.status(400).json({ error: "기록 원문이 너무 깁니다" });
      return;
    }

    try {
      const outputs = await generateRecordOutputs({
        type,
        text: text.trim(),
        patient: patient && typeof patient === "object" ? patient : {},
        staffName: typeof staffName === "string" ? staffName : "",
      });
      res.status(200).json(outputs);
    } catch (err) {
      logger.error("generateRecord 처리 중 오류", err);
      res.status(502).json({ error: "기록 생성 서비스 호출에 실패했습니다" });
    }
  }
);

// Agora App ID 조회 (App ID는 비밀값이 아니라 클라이언트 SDK 초기화에 반드시 필요한 공개 식별자.
// 다만 소스에 하드코딩하지 않고 App Certificate와 동일하게 Secret Manager로 일원 관리한다)
exports.agoraConfig = onRequest(
  {
    secrets: [AGORA_APP_ID],
    cors: ALLOWED_ORIGINS,
    region: "asia-northeast3",
  },
  async (req, res) => {
    if (!(await requireAppCheck(req, res))) return;
    res.status(200).json({ appId: AGORA_APP_ID.value() });
  }
);

const AGORA_TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24시간. 클라이언트가 만료 임박 시 자동 갱신 요청함

function isValidAgoraChannelName(name) {
  // 채널명은 이 앱이 정의한 슬러그만 허용한다 (자유 입력 금지 — 인젝션/오용 방지)
  return typeof name === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(name);
}

function sanitizeAgoraAccount(name) {
  if (typeof name !== "string") return "";
  return name.trim().slice(0, 64);
}

// 무전 채널 입장용 단기 RTC 토큰 발급 (App Certificate는 이 함수 밖으로 나가지 않음)
exports.agoraToken = onRequest(
  {
    secrets: [AGORA_APP_ID, AGORA_APP_CERTIFICATE],
    cors: ALLOWED_ORIGINS,
    region: "asia-northeast3",
  },
  async (req, res) => {
    if (!(await requireAppCheck(req, res))) return;
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST만 지원합니다" });
      return;
    }

    const { channelName, account } = req.body || {};
    if (!isValidAgoraChannelName(channelName)) {
      res.status(400).json({ error: "channelName이 올바르지 않습니다" });
      return;
    }
    const sanitizedAccount = sanitizeAgoraAccount(account);
    if (!sanitizedAccount) {
      res.status(400).json({ error: "account가 필요합니다" });
      return;
    }

    try {
      const token = RtcTokenBuilder.buildTokenWithUserAccount(
        AGORA_APP_ID.value(),
        AGORA_APP_CERTIFICATE.value(),
        channelName,
        sanitizedAccount,
        RtcRole.PUBLISHER,
        AGORA_TOKEN_TTL_SECONDS,
        AGORA_TOKEN_TTL_SECONDS
      );
      res.status(200).json({ token, expiresIn: AGORA_TOKEN_TTL_SECONDS });
    } catch (err) {
      logger.error("agoraToken 처리 중 오류", err);
      res.status(500).json({ error: "토큰 발급에 실패했습니다" });
    }
  }
);

// ============================================================
// 무전(PTT) 녹음 저장/조회 — 각 직원이 말한 발화 1건 = 클립 1개.
// 오디오 원본은 pttClipAudio, 메타데이터(발화자·시간·전사텍스트)는 pttClips 에 저장.
// 개인정보 보호를 위해 expireAt(생성 후 PTT_CLIP_TTL_DAYS일) 이후 스케줄러가 자동 삭제한다.
// ============================================================
const PTT_CLIP_TTL_DAYS = 30;
// Firestore 문서 상한(1MiB)을 넘지 않도록 오디오 원본 크기를 제한한다.
// (짧은 무전 발화 기준 충분. 초과분은 텍스트/메타만 저장하고 재생용 오디오는 생략)
const PTT_CLIP_MAX_AUDIO_BYTES = 680 * 1024;

// 무전 녹음 저장 (발화 종료 시 클라이언트가 호출) — 저장 전에 Whisper 로 전사 시도
exports.savePttClip = onRequest(
  {
    secrets: [OPENAI_API_KEY],
    cors: ALLOWED_ORIGINS,
    region: "asia-northeast3",
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (req, res) => {
    if (!(await requireAppCheck(req, res))) return;
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST만 지원합니다" });
      return;
    }

    const { audioBase64, mimeType, speaker, channelName, durationMs } = req.body || {};
    if (!audioBase64 || typeof audioBase64 !== "string") {
      res.status(400).json({ error: "audioBase64가 필요합니다" });
      return;
    }

    let audioBuffer;
    try {
      audioBuffer = Buffer.from(audioBase64, "base64");
    } catch (e) {
      res.status(400).json({ error: "잘못된 오디오 데이터입니다" });
      return;
    }
    if (audioBuffer.length === 0 || audioBuffer.length > MAX_AUDIO_BYTES) {
      res.status(400).json({ error: "오디오 크기가 올바르지 않습니다" });
      return;
    }

    // 전사 실패는 치명적이지 않다 — 텍스트 없이도 녹음 자체는 보관한다.
    let text = "";
    try {
      text = await transcribeAudioBuffer(audioBuffer, mimeType);
    } catch (e) {
      logger.warn("무전 전사 실패(녹음은 저장함)", e && e.message);
    }

    try {
      const expireAt = new Date(Date.now() + PTT_CLIP_TTL_DAYS * 24 * 60 * 60 * 1000);
      const storeAudio = audioBuffer.length <= PTT_CLIP_MAX_AUDIO_BYTES;
      const meta = {
        speaker: sanitizeAgoraAccount(speaker) || "알 수 없음",
        channelName: isValidAgoraChannelName(channelName) ? channelName : "",
        durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
        mimeType: typeof mimeType === "string" ? mimeType.slice(0, 64) : "audio/webm",
        text,
        hasAudio: storeAudio,
        createdAt: FieldValue.serverTimestamp(),
        expireAt,
      };
      // 오디오를 먼저 저장한 뒤 메타데이터를 기록한다. 오디오 저장이 실패하면
      // 메타데이터를 만들지 않아 "재생 불가한 목록 항목(orphan)"이 남지 않는다.
      const ref = db.collection("pttClips").doc();
      if (storeAudio) {
        await db.collection("pttClipAudio").doc(ref.id).set({ audioBase64, expireAt });
      }
      await ref.set(meta);
      res.status(200).json({ id: ref.id, text, hasAudio: storeAudio });
    } catch (err) {
      logger.error("savePttClip 처리 중 오류", err);
      res.status(500).json({ error: "녹음 저장에 실패했습니다" });
    }
  }
);

// 무전 녹음 목록 (최근 100건, 오디오 원본 제외한 메타데이터만)
// 녹음은 민감정보(요양 대화)라 열람은 관리자 PIN 인증을 요구한다.
exports.listPttClips = onRequest(
  {
    secrets: [ADMIN_PIN],
    cors: ALLOWED_ORIGINS,
    region: "asia-northeast3",
  },
  async (req, res) => {
    if (!(await requireAppCheck(req, res))) return;
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST만 지원합니다" });
      return;
    }
    if (!req.body || req.body.pin !== ADMIN_PIN.value()) {
      res.status(403).json({ error: "관리자 PIN이 필요합니다" });
      return;
    }
    try {
      const snap = await db.collection("pttClips").orderBy("createdAt", "desc").limit(100).get();
      const clips = snap.docs.map((d) => {
        const v = d.data();
        return {
          id: d.id,
          speaker: v.speaker || "",
          text: v.text || "",
          durationMs: v.durationMs || 0,
          hasAudio: v.hasAudio !== false,
          createdAt: v.createdAt && v.createdAt.toDate ? v.createdAt.toDate().toISOString() : null,
        };
      });
      res.status(200).json({ clips });
    } catch (err) {
      logger.error("listPttClips 처리 중 오류", err);
      res.status(500).json({ error: "녹음 목록을 불러오지 못했습니다" });
    }
  }
);

// 무전 녹음 1건의 오디오 원본 조회 (재생용) — 열람은 관리자 PIN 인증 필요
exports.getPttClip = onRequest(
  {
    secrets: [ADMIN_PIN],
    cors: ALLOWED_ORIGINS,
    region: "asia-northeast3",
  },
  async (req, res) => {
    if (!(await requireAppCheck(req, res))) return;
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST만 지원합니다" });
      return;
    }
    if (!req.body || req.body.pin !== ADMIN_PIN.value()) {
      res.status(403).json({ error: "관리자 PIN이 필요합니다" });
      return;
    }
    const { id } = req.body || {};
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "id가 필요합니다" });
      return;
    }
    try {
      const audioDoc = await db.collection("pttClipAudio").doc(id).get();
      if (!audioDoc.exists) {
        res.status(404).json({ error: "녹음을 찾을 수 없습니다" });
        return;
      }
      const metaDoc = await db.collection("pttClips").doc(id).get();
      const mimeType = (metaDoc.exists && metaDoc.data().mimeType) || "audio/webm";
      res.status(200).json({ audioBase64: audioDoc.data().audioBase64, mimeType });
    } catch (err) {
      logger.error("getPttClip 처리 중 오류", err);
      res.status(500).json({ error: "녹음을 불러오지 못했습니다" });
    }
  }
);

// 보관기간(30일) 지난 무전 녹음 자동 삭제 — 매일 1회 실행
exports.purgeExpiredPttClips = onSchedule(
  {
    schedule: "every 24 hours",
    region: "asia-northeast3",
    timeoutSeconds: 300,
  },
  async () => {
    const now = new Date();
    for (const coll of ["pttClips", "pttClipAudio"]) {
      let deleted = 0;
      for (;;) {
        const snap = await db.collection(coll).where("expireAt", "<=", now).limit(300).get();
        if (snap.empty) break;
        const batch = db.batch();
        snap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        deleted += snap.size;
        if (snap.size < 300) break;
      }
      logger.info(`purgeExpiredPttClips: ${coll} ${deleted}건 삭제`);
    }
  }
);

// 직원 명단 조회 (누구나 호출 가능, 읽기 전용 — 기기 식별 화면에서 사용)
exports.listStaff = onRequest(
  {
    cors: ALLOWED_ORIGINS,
    region: "asia-northeast3",
  },
  async (req, res) => {
    if (!(await requireAppCheck(req, res))) return;
    try {
      const staff = await fetchStaffList();
      res.status(200).json({ staff });
    } catch (err) {
      logger.error("listStaff 처리 중 오류", err);
      res.status(500).json({ error: "직원 목록을 불러오지 못했습니다" });
    }
  }
);

// 직원 명단 추가/삭제 (관리자 PIN 필요)
exports.manageStaff = onRequest(
  {
    secrets: [ADMIN_PIN],
    cors: ALLOWED_ORIGINS,
    region: "asia-northeast3",
  },
  async (req, res) => {
    if (!(await requireAppCheck(req, res))) return;
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST만 지원합니다" });
      return;
    }

    const { pin, action, name, id } = req.body || {};
    if (pin !== ADMIN_PIN.value()) {
      res.status(403).json({ error: "PIN이 올바르지 않습니다" });
      return;
    }

    try {
      if (action === "add") {
        const trimmed = typeof name === "string" ? name.trim() : "";
        if (!trimmed) {
          res.status(400).json({ error: "이름을 입력해 주세요" });
          return;
        }
        await db.collection("staff").add({ name: trimmed, createdAt: FieldValue.serverTimestamp() });
      } else if (action === "remove") {
        if (!id || typeof id !== "string") {
          res.status(400).json({ error: "id가 필요합니다" });
          return;
        }
        await db.collection("staff").doc(id).delete();
      } else if (action !== "list") {
        res.status(400).json({ error: "알 수 없는 action입니다" });
        return;
      }

      const staff = await fetchStaffList();
      res.status(200).json({ staff });
    } catch (err) {
      logger.error("manageStaff 처리 중 오류", err);
      res.status(500).json({ error: "처리 중 오류가 발생했습니다" });
    }
  }
);
