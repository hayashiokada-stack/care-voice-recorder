const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { RtcTokenBuilder, RtcRole } = require("agora-token");

initializeApp();
const db = getFirestore();

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

exports.transcribe = onRequest(
  {
    secrets: [OPENAI_API_KEY],
    cors: ALLOWED_ORIGINS,
    region: "asia-northeast3",
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (req, res) => {
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
        res.status(502).json({ error: "음성 인식 서비스 호출에 실패했습니다" });
        return;
      }

      const data = await openaiRes.json();
      res.status(200).json({ text: data.text || "" });
    } catch (err) {
      logger.error("transcribe 처리 중 오류", err);
      res.status(500).json({ error: "서버 오류가 발생했습니다" });
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

// 직원 명단 조회 (누구나 호출 가능, 읽기 전용 — 기기 식별 화면에서 사용)
exports.listStaff = onRequest(
  {
    cors: ALLOWED_ORIGINS,
    region: "asia-northeast3",
  },
  async (req, res) => {
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
