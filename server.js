// framer-blog-push — n8n이 보낸 새 글을 Framer blog 컬렉션에 "추가만" 하는 웹훅 서비스.
// - slug 중복 스킵, removeItems 절대 호출 안 함 → 기존 504 안전
// - Framer Server API(framer-api, Plugin API와 동일 능력) 사용
import express from "express";
import { connect } from "framer-api";

const app = express();
app.use(express.json({ limit: "4mb" }));

const PROJECT_URL = process.env.FRAMER_PROJECT_URL;      // JP: https://framer.com/projects/xxxxxxxx
const API_KEY = process.env.FRAMER_API_KEY;              // Site Settings → General에서 발급
const PUSH_SECRET = process.env.PUSH_SECRET || "";       // n8n과 공유하는 비밀값(헤더 x-push-secret)
const COLLECTION_NAME = process.env.FRAMER_COLLECTION || "blog";

// 멀티사이트: 요청 헤더 x-site(jp|en) 또는 ?site= 로 프로젝트/키/컬렉션 선택. 기본 jp(기존 호환).
function siteConfig(req) {
  const site = String((req.headers && req.headers["x-site"]) || (req.query && req.query.site) || "jp").toLowerCase();
  if (site === "en") {
    return {
      site: "en",
      projectUrl: process.env.FRAMER_PROJECT_URL_EN,
      apiKey: process.env.FRAMER_API_KEY_EN,
      collection: process.env.FRAMER_COLLECTION_EN || "blog",
    };
  }
  return { site: "jp", projectUrl: PROJECT_URL, apiKey: API_KEY, collection: COLLECTION_NAME };
}

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

function buildValue(field, raw, alt) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  switch (field.type) {
    case "enum": {
      const cases = field.cases ?? field.options ?? [];
      const hit = cases.find((c) => c.name === raw || c.id === raw);
      if (!hit) { console.warn(`[warn] enum case 없음: "${raw}" (필드 ${field.name})`); return undefined; }
      return { type: "enum", value: hit.id };
    }
    case "image": {
      // Framer 이미지 필드: value=URL, alt=대체텍스트(SEO·접근성). alt 없으면 생략.
      const v = { type: "image", value: String(raw) };
      if (alt) v.alt = String(alt);
      return v;
    }
    case "date": return { type: "date", value: String(raw) };
    case "formattedText": return { type: "formattedText", value: String(raw) };
    default: return { type: "string", value: String(raw) };
  }
}

// 발행: framer.publish()로 새 버전 발행 후, framer.deploy(id)로 프로덕션(라이브) 승격.
// AUTO_PUBLISH 환경변수가 "false"면 건너뜀(기본 켜짐).
async function tryPublish(framer) {
  if (String(process.env.AUTO_PUBLISH || "true").toLowerCase() === "false") {
    return { skipped: "AUTO_PUBLISH=false" };
  }
  if (typeof framer.publish !== "function") return { error: "framer.publish() 없음" };
  // publish()는 가끔 일시적 빌드 오류("ensureComponentsInLoader: Some modules are missing" 등)로
  // 실패한다 → 지수적 대기로 재시도. 한 번만 성공하면 CMS의 밀린 글이 전부 라이브로 flush됨.
  const MAX_TRIES = 4;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const result = await framer.publish();
      let deployed = null, deployErr = null;
      const depId = result?.deployment?.id || result?.deploymentId || result?.id;
      if (depId && typeof framer.deploy === "function") {
        try { deployed = await framer.deploy(depId); }
        catch (e) { deployErr = String(e?.message || e); }
      }
      return { published: true, tries: attempt, deploymentId: depId || null, deployed: !!deployed, deployErr };
    } catch (e) {
      lastErr = String(e?.message || e);
      console.warn(`[publish] 시도 ${attempt}/${MAX_TRIES} 실패: ${lastErr}`);
      if (attempt < MAX_TRIES) await new Promise((r) => setTimeout(r, attempt * 7000));
    }
  }
  return { error: lastErr, triedTimes: MAX_TRIES };
}

app.post("/push", async (req, res) => {
  try {
    if (PUSH_SECRET && req.headers["x-push-secret"] !== PUSH_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const cfg = siteConfig(req);
    if (!cfg.projectUrl || !cfg.apiKey) {
      return res.status(500).json({ error: `FRAMER_PROJECT_URL / FRAMER_API_KEY 미설정 (site=${cfg.site})` });
    }

    const body = req.body;
    const posts = Array.isArray(body) ? body : (body?.posts ?? [body]);

    const framer = await connect(cfg.projectUrl, cfg.apiKey);
    try {
      const collections = await framer.getCollections();
      const collection = collections.find(
        (c) => (c.name || "").toLowerCase() === cfg.collection.toLowerCase()
      );
      if (!collection) throw new Error(`컬렉션 "${cfg.collection}" (site=${cfg.site}) 를 찾지 못함. 있는 것: ${collections.map(c=>c.name).join(", ")}`);

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
        // thumbnail(image) 필드엔 alt 텍스트로 기사 제목을 넣는다(SEO·접근성). 제목 없으면 slug.
        const altText = String(p.title || slug || "").trim();
        for (const key of Object.keys(FIELD_MAP)) {
          const f = fieldByName.get(FIELD_MAP[key]);
          if (!f) continue;
          const v = buildValue(f, p[key], key === "thumbnail" ? altText : undefined);
          if (v !== undefined) fieldData[f.id] = v;
        }
        // 별도 "slug" 텍스트 필드(WP 이전 컬렉션에 존재)에도 URL slug와 동일 값을 자동 기입.
        // FIELD_MAP엔 없지만 이름이 slug인 필드가 있으면 비어있을 때 채운다.
        for (const f of fields) {
          if (/^slug$/i.test(f.name) && fieldData[f.id] === undefined) {
            const v = buildValue(f, slug);
            if (v !== undefined) fieldData[f.id] = v;
          }
        }
        toAdd.push({ slug, fieldData });
        existingSlugs.add(slug);
      }

      if (toAdd.length) await collection.addItems(toAdd);
      const published = toAdd.length ? await tryPublish(framer) : null;

      res.json({ ok: true, site: cfg.site, collection: collection.name, added: toAdd.length, skipped, published });
    } finally {
      await framer.disconnect();
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 진단(read-only): blog 컬렉션 필드 목록 + 샘플 아이템의 채워진 필드 확인.
// 예: GET /fields?secret=<PUSH_SECRET>
app.get("/fields", async (req, res) => {
  try {
    if (PUSH_SECRET && req.query.secret !== PUSH_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const cfg = siteConfig(req);
    // 진단용: ?projecturl= / ?collection= 로 임시 오버라이드(URL 형식 테스트).
    if (req.query.projecturl) cfg.projectUrl = String(req.query.projecturl);
    if (req.query.collection) cfg.collection = String(req.query.collection);
    if (!cfg.projectUrl || !cfg.apiKey) {
      return res.status(500).json({ error: `FRAMER env 미설정 (site=${cfg.site})` });
    }
    const framer = await connect(cfg.projectUrl, cfg.apiKey);
    try {
      const collections = await framer.getCollections();
      const collection = collections.find(
        (c) => (c.name || "").toLowerCase() === cfg.collection.toLowerCase()
      );
      if (!collection) throw new Error(`컬렉션 "${cfg.collection}" (site=${cfg.site}) 없음. 있는 것: ${collections.map(c=>c.name).join(", ")}`);
      const fields = await collection.getFields();
      const items = await collection.getItems();
      const byId = new Map(fields.map((f) => [f.id, f]));
      // 진단: category 필드의 고유값 목록(자동 카테고리 지정용).
      const catField = fields.find((f) => (f.name || "").toLowerCase() === "category");
      const distinctCategories = catField
        ? [...new Set(items.map((i) => (i.fieldData && i.fieldData[catField.id] && i.fieldData[catField.id].value) || "").filter(Boolean))].slice(0, 50)
        : [];
      // ?slug=x 지정 시 해당 아이템, 없으면 첫 아이템을 샘플로.
      const wantSlug = String(req.query.slug || "").trim();
      const sample = wantSlug ? items.find((i) => i.slug === wantSlug) : items[0];
      const sampleFieldData = sample
        ? Object.entries(sample.fieldData || {}).map(([id, v]) => ({
            name: (byId.get(id) || {}).name,
            type: v?.type,
            value: typeof v?.value === "string" ? v.value.slice(0, 60) : v?.value,
            alt: v?.alt,
          }))
        : [];
      res.json({
        site: cfg.site,
        collection: collection.name,
        itemCount: items.length,
        fields: fields.map((f) => ({ name: f.name, type: f.type })),
        distinctCategories,
        sampleSlug: sample?.slug,
        sampleFieldData,
      });
    } finally {
      await framer.disconnect();
    }
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/", (_req, res) => res.type("text").send("framer-blog-push ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("framer-blog-push listening on " + port));
