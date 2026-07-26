const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

// GitHub Pages 배포 origin만 허용 (필요 시 여기에 추가 origin을 넣으세요)
const ALLOWED_ORIGINS = ["https://hayashiokada-stack.github.io"];

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // OpenAI 업로드 제한과 동일

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
      const extension = (mimeType || "").includes("webm") ? "webm" : "mp4";
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
