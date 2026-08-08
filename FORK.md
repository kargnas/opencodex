# kargnas/opencodex fork

upstream: https://github.com/lidge-jun/opencodex

이 fork는 ai-proxy2.zz.gg 배포용이다. 정책: **아주 작은 패치 + 기능 추가만** 유지하고,
upstream을 주기적으로 merge해서 버전을 따라간다. upstream이 고치면 우리 패치는 삭제한다.

## 브랜치

- `main` — upstream/main 미러. 직접 커밋 금지, fast-forward만.
- `zzgg` — 배포 브랜치. `main` 위에 우리 패치를 얹는다.
  damn-gfw의 `docker/production/Dockerfile.opencodex`가 이 브랜치의 sha를 핀한다.

## 현재 패치 목록 (upstream 반영되면 삭제)

- `fix(gui): complete OAuth logins from the web UI` — ① add-provider 모달 Accounts 탭이
  로그인 URL/device code를 렌더하지 않던 것 ② 이미 로그인된 provider에 계정 추가 시
  완료 오탐(`loggedIn`/계정수 baseline)으로 모달 즉사 → `done` 판정으로 교체
  ③ loopback 콜백(Anthropic localhost:54545) 리다이렉트 URL 수동 paste 입력을
  워크스페이스 패널·모달 계정 행에 추가.

## upstream 동기화 절차

```sh
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout zzgg && git merge main        # 충돌 시 우리 패치 쪽을 최소로 유지
bun install --frozen-lockfile
bun x tsc --noEmit && (cd gui && bun x tsc --noEmit && bun run lint)
bun test tests/provider-workspace-auth.test.ts tests/oauth-tos-warning.test.ts
bun run build:gui                          # 패키징 스모크 (gui/dist는 gitignore)
git push origin zzgg
```

이후 damn-gfw `docker/production/Dockerfile.opencodex`의 `OPENCODEX_REF`를
새 zzgg sha로 교체하고 push하면 GitOps가 배포한다.

## 배포 형태

이미지 builder 스테이지가 이 repo를 `OPENCODEX_REF`로 shallow-fetch →
`bun run build:gui` → `npm pack` → 런타임 스테이지에서 타르볼 글로벌 설치.
npm 배포본과 같은 설치 레이아웃이라 `bin/ocx.mjs` 런처가 그대로 동작한다.
