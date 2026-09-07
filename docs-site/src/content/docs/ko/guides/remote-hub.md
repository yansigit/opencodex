---
title: Remote Hub 배포
description: Linux, macOS, Docker에서 관리 포트는 로컬에만 열고 Tailscale Serve와 헤드리스 OAuth를 사용하는 방법입니다.
---

Remote Hub를 쓰면 프로바이더 인증 정보와 사용량 기록은 허브 한 곳에 두고, 인증된 클라이언트가 허브의 데이터 API를 직접 사용합니다. 브라우저용 관리 API는 별도입니다. 선택 사항인 관리 리스너는 `127.0.0.1`에만 열리며 대시보드와 `/api/*`만 제공합니다.

관리 포트에서는 `/v1/*`, `/healthz`, `/readyz`, WebSocket을 제공하지 않습니다. 이 포트를 직접 공개하거나 방화벽에 열지 말고 Tailscale Funnel도 사용하지 마세요.

## 역할과 데이터 흐름

- `standalone`: 데이터와 관리를 한 컴퓨터에서 처리합니다.
- `hub`: 프로바이더 키, 카탈로그, 사용량 기록을 보관합니다.
- `client`: 연결 정보와 클라이언트 전용 데이터 키 하나만 보관합니다.

Codex와 Claude 요청은 클라이언트에서 허브의 데이터 리스너로 바로 갑니다. 대시보드나 로컬 관리 릴레이를 거치지 않습니다.

```bash
ocx connect https://hub-name.tailnet-name.ts.net --pairing-code-stdin
ocx connect status
ocx sync
```

허브가 발급한 클라이언트별 키는 권한이 제한된 `service-api-token` 파일에 저장됩니다. `config.json`에는 저장되지 않습니다. 연결 중 사용량은 허브 기록에서 해당 `apiKeyId`만 조회하고, 연결을 끊은 뒤에는 로컬 기록을 봅니다. 두 기록은 서로 복제되지 않습니다.

## 보안과 동의 경계

- 프로바이더/OAuth 인증 정보는 허브 밖으로 복사하지 마세요.
- 데이터 키는 `service-api-token` 또는 `OCX_API_TOKEN_FILE`로 전달하며 관리 권한이 없습니다.
- 관리자 토큰은 일반 관리 작업만 할 수 있습니다. 브라우저 동의 세션을 만들거나 저장소 Star 같은 동의 작업을 승인할 수는 없습니다. 그런 작업에는 서버가 발급한 `gui-session`, 일치하는 Origin, CSRF 토큰이 필요합니다.
- `Tailscale-User-Login`은 별도 관리 리스너에서만 신뢰합니다. 공개 리스너의 같은 헤더는 무시합니다. `remoteGui.allowedTailscaleUsers`에는 허용할 로그인 ID를 정확히 적으세요.

## systemd 또는 launchd

```bash
ocx config set runtimeRole hub
ocx config set hostname 100.64.0.10
ocx config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
ocx config set corsAllowOrigins '["http://localhost:10100"]'
ocx config set hub.managementIngress '{"enabled":true,"port":10101}'
ocx config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'
export OPENCODEX_API_AUTH_TOKEN="$(openssl rand -hex 32)"
ocx service install
ocx service status
```

`ocx service install`은 키를 기존 `service-api-token` 경로에 안전하게 저장합니다. plist나 systemd unit에는 실제 키가 들어가지 않습니다.

```bash
curl --fail --silent http://100.64.0.10:10100/healthz
curl --fail --silent http://100.64.0.10:10100/readyz
```

`/healthz`의 `200`은 프로세스가 살아 있다는 뜻뿐입니다. 실제 배포 확인에는 `/readyz`, 인증된 `GET /v1/catalog`, 실제 모델 요청 1회가 모두 필요합니다.

## Tailscale Serve

```bash
ss -ltnp | grep 10101
lsof -nP -iTCP:10101 -sTCP:LISTEN
tailscale serve --bg --https=443 http://127.0.0.1:10101
tailscale serve status
```

관리 포트는 `127.0.0.1:10101`에서만 보여야 합니다. `hub.managementPublicOrigin`은 Serve가 표시한 정확한 HTTPS Origin으로 설정하세요. 직접 TLS 프록시를 운영한다면 `tailscale cert hub-name.tailnet-name.ts.net`으로 ts.net 전체 FQDN 인증서만 발급하고 `127.0.0.1:10101`로만 프록시하세요. 임의의 `Tailscale-User-*` 헤더를 만들지 말고, 신뢰할 수 있는 Tailscale 신원이 없으면 일회용 pairing을 사용하세요.

## 헤드리스 OAuth

```bash
ocx config set oauthOpenBrowser false
```

인증된 대시보드에서 `POST /api/oauth/login`을 시작하고, 운영자 컴퓨터에서 반환된 URL을 엽니다. 콜백이 허브에 닿지 않으면 최종 리디렉션 URL이나 코드를 `POST /api/oauth/login/code`의 `{provider,input}`으로 전달하세요. OAuth 코드를 argv, 로그, 이슈, 스크린샷에 남기지 마세요.

## 키 교체와 연결 해제

```bash
ocx connect rotate --pairing-code-stdin
# HTTPS에서만:
ocx connect rotate --admin-token-stdin
```

기존 키와 새 키는 같은 `apiKeyId`로 최대 10분 동안 함께 유효합니다. 클라이언트는 기존 키를 `service-api-token.prev`에 백업하고, 새 키를 원자적으로 적용해 `/v1/catalog`로 확인한 다음 확정합니다. 결과가 불확실하면 임시 권한을 다시 넣어 같은 명령을 실행하세요. 현재 파일과 `.prev`를 모두 확인한 뒤 확정하거나 복원합니다.

`ocx disconnect`는 허브가 꺼져 있어도 로컬 상태를 복원하며 허브 키를 삭제하지 않습니다. 연결을 끊은 뒤에는 허브 대시보드의 **Integrations → API Keys**에서 키를 삭제해야 합니다. `ocx connect revoke --admin-token-stdin`은 연결 중에만 사용할 수 있으며 저장된 `apiKeyId`만 사용합니다.

## Docker

opencodex는 공식 컨테이너 이미지를 배포하지 않지만, 저장소 루트의 `Dockerfile`과 `compose.yaml`로 digest가 고정된 소스 이미지를 직접 빌드할 수 있습니다. 최초 정상 시작 시 자체 서명 TLS 인증서와 개인 키를 `ocx-state` 볼륨의 `/home/bun/.opencodex/container-tls/cert.pem`과 `/home/bun/.opencodex/container-tls/key.pem`에 생성합니다. 개인 키는 소유자만 읽을 수 있으며 이후 시작에서는 같은 인증서와 키를 검증한 뒤 다시 사용합니다. 데이터 엔드포인트는 HTTPS입니다.

최초 정상 시작 전에 데이터 키를 stdin으로 한 번만 초기화하세요. bootstrap helper는 최대 512바이트인 한 줄만 허용합니다. 키를 출력하거나 기존 키를 덮어쓰지 않고 `ocx-state` 볼륨의 소유자 전용 `service-api-token`에 저장합니다.

호스트에 Git과 Bun이 필요합니다. 이미지를 빌드할 때마다 Git이 추적하는 소스로 정식 매니페스트를 생성하고, 생성부터 빌드 사이에는 소스를 변경하지 마세요. 생성된 JSON은 Git에 추가하지 않으며 `.git`은 Docker 컨텍스트에서 제외됩니다. 호스트 포트는 기본적으로 `127.0.0.1:10100`에 바인딩됩니다. `OPENCODEX_PORT`는 호스트 포트와 관리되는 TLS의 `publicOrigin`을 함께 변경하지만 컨테이너 내부 리스너는 `10100`을 유지합니다.

빌드는 오래된 매니페스트를 거부하며 모든 SHA-256을 컨텍스트와 복사된 파일에 각각 대조합니다. 매니페스트는 `Dockerfile`, `compose.yaml`, `.dockerignore`, Git이 추적하는 모든 Docker authority 파일, `src/`, `package.json`, `bun.lock`, `scripts/model-metadata.source.json`을 인증합니다. 누락되거나 일치하지 않는 파일, 매니페스트에 없는 추가 소스 또는 Docker authority 파일, 심볼릭 링크는 거부됩니다.

```bash
git clone https://github.com/yansigit/opencodex.git
cd opencodex
bun scripts/generate-compatibility-version.ts
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
```

호스트에서 기본 게시를 확인하려면 공개 인증서만 복사해 로컬 CA로 사용하세요. 개인 키는 복사하지 마세요.

```bash
mkdir -p .tmp
docker compose cp hub:/home/bun/.opencodex/container-tls/cert.pem .tmp/opencodex-container-ca.pem
curl --cacert .tmp/opencodex-container-ca.pem --fail --silent https://localhost:10100/healthz
```

다른 호스트 포트를 사용한다면 이후 Compose 실행에도 같은 값을 지정하세요.

```bash
OPENCODEX_PORT=10190 docker compose up -d
curl --cacert .tmp/opencodex-container-ca.pem --fail --silent https://localhost:10190/healthz
```

원격 공개는 `OPENCODEX_BIND_ADDRESS=<LAN-또는-Tailscale-IP>`로 명시적으로 선택하며, `0.0.0.0`은 모든 인터페이스에 공개합니다. 생성된 인증서는 `localhost`와 `127.0.0.1`만 포함합니다. 원격으로 직접 공개하려면 생성된 인증서와 키를 정확한 원격 이름에 맞는 인증서와 키로 교체하고, `OPENCODEX_PUBLIC_ORIGIN=https://hub.example.com:10100`처럼 경로, 자격 증명, 쿼리, 프래그먼트가 없는 정확한 HTTPS origin을 지정하세요. 방화벽과 인증된 TLS/tailnet 프런트엔드로 보호해야 합니다.

TLS 도입 전에 만든 볼륨을 유지하고 있다면 다음 시작에서 볼륨별 TLS identity와 게시된 호스트 포트를 사용하는 HTTPS origin으로 자동 마이그레이션합니다. 운영자가 지정한 인증서 경로는 보존됩니다. 이전 HTTP 전용 이미지로 롤백하려면 현재 이미지를 사용할 수 있을 때 hub를 중지하고 TLS 설정만 제거한 뒤 이전 이미지를 시작하세요. 인증서 파일은 볼륨에 남아 있어도 됩니다.

```bash
docker compose down
docker compose run --rm hub bun run src/cli/index.ts config unset tls
# 이전 이미지를 선택하거나 빌드한 다음 hub를 다시 생성
docker compose up -d
```

이미지는 non-root `bun` 사용자로 실행되고 루트 파일 시스템은 read-only이며 공개 포트는 `10100` 하나뿐입니다. 토큰을 `ARG`, `ENV`, `COPY`, Compose YAML, 이미지 기록, 명령행에 넣지 마세요. Docker socket, 호스트 홈, Codex 홈, SSH agent, 프로바이더 키도 마운트하지 마세요. 컨테이너 안의 `127.0.0.1:10101` 관리 포트는 같은 네트워크 네임스페이스의 TLS/tailnet 프런트엔드로만 연결하고 직접 publish하지 마세요.

컨테이너 내부 health/readiness probe가 인증서 검증을 생략할 수 있는 범위는 고정된 컨테이너 루프백 연결뿐입니다. 외부 인수 검사에서는 복사한 공개 인증서나 시스템 신뢰 저장소를 사용해 실제로 접속하는 정확한 호스트 이름을 반드시 검증하세요. 컨테이너 healthcheck의 `/healthz`가 통과한 뒤 인증된 `/v1/catalog`와 실제 모델 응답도 별도로 확인해야 합니다.

`docker compose down`은 `ocx-state` 볼륨을 보존합니다. `docker compose down --volumes`는 설정, OAuth 인증 정보, 사용량 기록, 데이터 키를 함께 삭제하므로 파괴적 작업으로 취급하세요.

## 롤백과 문제 해결

`tailscale serve reset`은 노드의 모든 매핑을 지우므로 먼저 `tailscale serve status`를 확인하세요. 서비스 롤백 때는 같은 `OPENCODEX_HOME`을 유지한 채 이전 릴리스를 `ocx service repair`로 복구합니다.

- 허브가 꺼져 있으면 `ocx disconnect`로 오프라인 복원할 수 있지만 원격 키는 삭제되지 않습니다.
- 일시적 허브 오류에서는 검증된 마지막 카탈로그를 유지합니다. 인증·스키마·크기·프로토콜 오류는 로컬 프로바이더로 대체하지 않습니다.
- `.prev` 복구가 필요하면 두 파일을 지우지 말고 임시 권한과 함께 `ocx connect rotate`를 다시 실행하세요.
- `hub-too-new` 또는 `hub-too-old`가 나오면 메시지가 가리키는 오래된 쪽을 업그레이드하세요. 불일치는 로컬 파일을 쓰기 전에 차단됩니다.
- pairing 코드는 일회용이며 반복 실패는 429로 제한됩니다. 코드를 잃었거나 소진했다면 새로 만드세요.
- 루프백이 아닌 HTTP pairing은 `--allow-insecure-http`를 명시해야 합니다. 관리자 토큰은 HTTP로 보내지 않습니다.
- 브라우저 로그아웃/만료는 해당 원격 세션만 끊습니다. 데이터 키와는 별개입니다.
- 연결 해제 후 남은 키는 허브의 **Integrations → API Keys**에서만 폐기할 수 있습니다.
