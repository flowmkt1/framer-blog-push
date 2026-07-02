// framer-blog-push — n8n이 보낸 새 글을 Framer blog 컬렉션에 "추가만" 하는 웹훅 서비스.
// - slug 중복 스킵, removeItems 절대 호출 안 함 → 기존 504 안전
// - Framer Server API(framer-api, Plugin API와 동일 능력) 사용
import express from "express";
import { connect } from "framer-api";

const app = express();
app.use(express.json({ limit: "4mb" }));

const PROJECT_URL = process.env.FRAMER_PROJECT_URL;      // 예: https://framer.com/projects/xxxxxxxx
const API_KEY = process.env.FRAMER_API_KEY;              // Site Settings → General에서 발급
const PUSH_SECRET = process.env.PUSH_SECRET || "";       // n8n과 공유하는 비밀값(헤더 x-push-secret)
const COLLECTION_NAME = process.env.FRAMER_COLLECTION || "blog";

// 피드 키 → blog 필드 "이름" 매핑 (blog 필드명이 다르면 여기만 수정)
const FIELD_MAP = {
  title: "title",
  content: "content",
  description: "description",
  category: "category",
  thumbnail: "thumbnail",
  pubDate: "pubDate",
  status: "Status",
};

function buildValue(field, raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  switch (field.type) {
    case "enum": {
      const cases = field.cases ?? field.options ?? [];
      const hit = cases.find((c) => c.name === raw || c.id === raw);
      if (!hit) { console.warn(`[warn] enum case 없음: "${raw}" (필드 ${field.name})`); return undefined; }
      return { type: "enum", value: hit.id };
    }
    case "image": return { type: "image", value: String(raw) };
    case "date": return { type: "date", value: String(raw) };
    case "formattedText": return { type: "formattedText", value: String(raw) };
    default: return { type: "string", value: String(raw) };
  }
}

// 발행 메서드 이름이 문서상 불확실 → 후보를 순서대로 시도(있는 것만 실행)
async function tryPublish(framer) {
  for (const m of ["publish", "publishProject", "publishSite"]) {
    if (typeof framer[m] === "function") {
      try { await framer[m](); return m; } catch (e) { console.warn(`publish(${m}) 실패:`, e?.message); }
    }
  }
  return null;
}

app.post("/push", async (req, res) => {
  try {
    if (PUSH_SECRET && req.headers["x-push-secret"] !== PUSH_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }
    if (!PROJECT_URL || !API_KEY) {
      return res.status(500).json({ error: "FRAMER_PROJECT_URL / FRAMER_API_KEY 미설정" });
    }

    const body = req.body;
    const posts = Array.isArray(body) ? body : (body?.posts ?? [body]);

    const framer = await connect(PROJECT_URL, API_KEY);
    try {
      const collections = await framer.getCollections();
      const collection = collections.find(
        (c) => (c.name || "").toLowerCase() === COLLECTION_NAME.toLowerCase()
      );
      if (!collection) throw new Error(`컬렉션 "${COLLECTION_NAME}" 를 찾지 못함. 있는 것: ${collections.map(c=>c.name).join(", ")}`);

      const fields = await collection.getFields();
      const fieldByName = new Map(fields.map((f) => [f.name, f]));
      const existing = await collection.getItems();
      const existingSlugs = new Set(existing.map((i) => i.slug));

      const toAdd = [];
      const skipped = [];
      for (const p of posts) {
        const slug = String(p.slug || "").trim();
        if (!slug) { skipped.push(`(no slug) ${p.title || ""}`); continue; }
        if (existingSlugs.has(slug)) { skipped.push(`(dup) ${slug}`); continue; }
        const fieldData = {};
        for (const key of Object.keys(FIELD_MAP)) {
          const f = fieldByName.get(FIELD_MAP[key]);
          if (!f) continue;
          const v = buildValue(f, p[key]);
          if (v !== undefined) fieldData[f.id] = v;
        }
        toAdd.push({ slug, fieldData });
        existingSlugs.add(slug);
      }

      if (toAdd.length) await collection.addItems(toAdd);
      const published = toAdd.length ? await tryPublish(framer) : null;

      res.json({ ok: true, added: toAdd.length, skipped, published });
    } finally {
      await framer.disconnect();
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/", (_req, res) => res.type("text").send("framer-blog-push ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("framer-blog-push listening on " + port));
