# framer-blog-push — 완전 무인 자동화 (Framer Server API)

n8n이 만든 새 글을 **에디터 없이 서버에서 직접** `blog` 컬렉션에 추가하는 웹훅 서비스.
- slug 중복 스킵, **삭제 없음 → 기존 504 안전**
- Framer **Server API**(`framer-api`) 사용 — 수동 Sync/플러그인 실행 불필요

**최종 무인 구조:**
```
n8n(스케줄) → 기사·이미지 생성 → [Push to Framer] HTTP → 이 웹훅 → blog에 자동 삽입 + 발행
```

---

## 0. 먼저 Framer에서 준비
1. Framer → **Site Settings → General → API 키 생성** → 복사 (`FRAMER_API_KEY`)
2. 프로젝트 URL 확인: `https://framer.com/projects/<id>` (`FRAMER_PROJECT_URL`)
   - API 키 생성 버튼이 안 보이면 → 사이트 플랜 문제일 수 있음(오픈베타지만 유료 플랜 필요할 수 있음). 알려주세요.

## 1. 무료 호스트(Render)에 배포
1. 이 폴더(`framer-blog-push`: `package.json`, `server.js`)를 **GitHub 레포**에 올리기
2. [render.com](https://render.com) → **New → Web Service** → 그 레포 연결
   - Runtime: **Node**, Build: `npm install`, Start: `npm start`
3. **Environment(환경변수)** 추가:
   | 키 | 값 |
   |---|---|
   | `FRAMER_PROJECT_URL` | `https://framer.com/projects/<id>` |
   | `FRAMER_API_KEY` | (0번에서 발급한 키) |
   | `PUSH_SECRET` | 아무 임의 문자열 (n8n과 동일하게) |
   | `FRAMER_COLLECTION` | `blog` |
4. 배포 완료 → URL 확인 (예: `https://framer-blog-push.onrender.com`)
5. 브라우저로 그 URL 접속 → **"framer-blog-push ok"** 뜨면 정상
   - Render 무료는 미사용 시 잠들어서 첫 호출이 ~50초 걸릴 수 있음(정상)

## 2. n8n에 "Push to Framer" 노드 추가
1. `push-to-framer-node.json` 내용 복사 → n8n 캔버스에 **Ctrl+V**
2. 그 노드에서:
   - **URL** → `https://<배포URL>/push`
   - 헤더 **x-push-secret** → 위 `PUSH_SECRET`과 동일 값
3. 연결: **`Update Sheet6 (Framer)` → `Push to Framer`** (드래그로 이음)
   - (시트 기록은 그대로 두고, 마지막에 Framer로도 쏘는 구조)

이제 스케줄이 돌면: 생성 → 시트 기록 → **Push to Framer가 blog에 자동 삽입**. 사람 손 0.

---

## 3. 첫 실행 때 확인 (Push to Framer 노드 응답 보기)
`/push` 응답 JSON으로 결과가 옵니다:
```json
{ "ok": true, "added": 1, "skipped": [], "published": "publish" }
```
- `added ≥ 1` → blog에 들어감 ✅
- `skipped: ["(dup) ..."]` → 이미 있는 slug (정상)
- `error` 발생 시 메시지로 원인 확인:
  - `컬렉션 "blog" 못 찾음` → `FRAMER_COLLECTION` 확인
  - `enum case 없음: category` → blog의 category 선택지 이름과 우리 값이 정확히 같은지
  - `published: null` → 자동 발행 메서드가 달라서일 수 있음. 이 경우 글은 들어가지만 사이트 반영 위해 수동 Publish 필요할 수 있음 → 알려주세요(발행 메서드 조정).

## 4. 확인 안 된 부분(문서 미기재 → 첫 실행으로 검증)
- 이미지/날짜/enum 필드 데이터 형식(Plugin API 기준으로 작성)
- 자동 발행(`publish`) 메서드 이름 — 후보 3개를 시도하게 해둠(`published` 값으로 성공 여부 확인)

배포 URL이랑 PUSH_SECRET 세팅되면, 제가 n8n에서 워크플로우를 돌려 **Push to Framer 응답을 직접 확인**해서 blog에 잘 들어갔는지 검증하겠습니다.
