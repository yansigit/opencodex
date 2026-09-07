---
title: Remote Hub のデプロイ
description: 管理ポートをループバックに限定し、Tailscale Serve とヘッドレス OAuth で運用します。
---

Remote Hub はプロバイダー認証情報、カタログ、使用量を一台のホストに保持し、認証済みクライアントからデータプレーンへ直接接続します。管理プレーンは別系統で、任意の管理リスナーは `127.0.0.1` にのみバインドされ、ダッシュボードと `/api/*` だけを提供します。`/v1/*`、`/healthz`、`/readyz`、WebSocket は提供しません。`10101` を公開したり Tailscale Funnel を使ったりしないでください。

## 役割、接続、信頼境界

`standalone` は一台で完結し、`hub` はプロバイダー秘密情報と使用量を所有し、`client` は接続状態とクライアント専用データキーだけを保存します。

```bash
ocx connect https://hub-name.tailnet-name.ts.net --pairing-code-stdin
ocx connect status
ocx sync
```

発行されたキーは所有者だけが読める `service-api-token` に保存され、`config.json` には入りません。接続中の使用量は hub 側で同じ `apiKeyId` に絞り込まれ、切断後はローカル保存分を表示します。両者はミラーリングされません。

管理トークンは通常の管理だけに使え、同意セッションを作ることは永久にできません。同意操作にはサーバー発行の `gui-session`、一致する Origin、CSRF が必要です。`Tailscale-User-Login` は専用管理リスナーでのみ信頼し、許可する ID を `remoteGui.allowedTailscaleUsers` に正確に設定します。

## サービスと Tailscale Serve

```bash
ocx config set runtimeRole hub
ocx config set hostname 100.64.0.10
ocx config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
ocx config set corsAllowOrigins '["http://localhost:10100"]'
ocx config set hub.managementIngress '{"enabled":true,"port":10101}'
ocx config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'
export OPENCODEX_API_AUTH_TOKEN="$(openssl rand -hex 32)"
ocx service install
```

launchd/systemd は保護された `service-api-token` を読み、設定ファイルへ秘密値を埋め込みません。

```bash
curl --fail --silent http://100.64.0.10:10100/healthz
curl --fail --silent http://100.64.0.10:10100/readyz
tailscale serve --bg --https=443 http://127.0.0.1:10101
tailscale serve status
```

`/healthz` の `200` はプロセスの生存確認にすぎません。`/readyz`、認証済み `GET /v1/catalog`、実際のモデル応答も確認してください。独自 TLS プロキシでは `tailscale cert hub-name.tailnet-name.ts.net` を使い、`127.0.0.1:10101` のみに転送します。`Tailscale-User-*` を偽造せず、信頼できる ID がない場合は一度限りのペアリングを使います。

## OAuth、キー更新、切断

```bash
ocx config set oauthOpenBrowser false
ocx connect rotate --pairing-code-stdin
# HTTPS のみ:
ocx connect rotate --admin-token-stdin
```

OAuth は `POST /api/oauth/login` で開始し、コールバックできない場合は最終 URL またはコードを `{provider,input}` として `POST /api/oauth/login/code` へ渡します。コードを argv やログに残さないでください。

キー更新では最大10分間、旧キーと新キーが同じ `apiKeyId` で有効です。旧キーを `service-api-token.prev` に保存し、新キーを原子的に置換して `/v1/catalog` で確認後に確定します。結果が不明な場合は一時権限を使って同じコマンドを再実行し、両候補の判定が終わるまで削除しないでください。

`ocx disconnect` は hub が停止中でもローカル状態を復元しますが、hub のキーは失効させません。切断後は hub の **Integrations → API Keys** だけが失効経路です。`ocx connect revoke --admin-token-stdin` は接続中のみ利用できます。

## Docker とトラブルシューティング

公式 Docker イメージはありませんが、リポジトリには digest 固定の Bun イメージをローカルビルドするための、管理された `Dockerfile` と `compose.yaml` があります。初回の通常起動時に、自己署名 TLS 証明書と秘密鍵を `ocx-state` ボリュームの `/home/bun/.opencodex/container-tls/cert.pem` と `/home/bun/.opencodex/container-tls/key.pem` に生成します。秘密鍵は所有者だけが読み取れ、以降の起動では同じ証明書と鍵を検証して再利用します。データエンドポイントは HTTPS です。

初回の通常起動前に、データキーを stdin から一度だけ初期化します。bootstrap helper が受け付けるのは最大 512 バイトの 1 行だけです。キーは表示されず、既存のキーは上書きせず、`ocx-state` ボリューム内の所有者限定 `service-api-token` に保存されます。

ホストに Git と Bun が必要です。イメージをビルドするたびに、Git 管理下のソースから正規のマニフェストを生成し、生成後はビルドまでソースを変更しないでください。生成 JSON は Git に追加せず、`.git` は Docker コンテキストから除外します。ホスト側は既定で `127.0.0.1:10100` にバインドします。`OPENCODEX_PORT` はホスト側ポートと管理対象 TLS の `publicOrigin` の両方を変更しますが、コンテナ内のリスナーは `10100` のままです。

ビルドは古いマニフェストを拒否し、すべての SHA-256 をコンテキストとコピー後のファイルに照合します。マニフェストは `Dockerfile`、`compose.yaml`、`.dockerignore`、Git 管理下のすべての Docker authority ファイル、`src/`、`package.json`、`bun.lock`、`scripts/model-metadata.source.json` を認証します。欠落・不一致のファイル、マニフェストにない余分なソースまたは Docker authority ファイル、シンボリックリンクは拒否されます。

```bash
git clone https://github.com/yansigit/opencodex.git
cd opencodex
bun scripts/generate-compatibility-version.ts
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
```

ホストから確認するには、公開証明書だけをコピーしてローカル CA として使います。秘密鍵はコピーしないでください。

```bash
mkdir -p .tmp
docker compose cp hub:/home/bun/.opencodex/container-tls/cert.pem .tmp/opencodex-container-ca.pem
curl --cacert .tmp/opencodex-container-ca.pem --fail --silent https://localhost:10100/healthz
```

別のホスト側ポートを使う場合は、以降の Compose 実行でも同じ値を指定します。

```bash
OPENCODEX_PORT=10190 docker compose up -d
curl --cacert .tmp/opencodex-container-ca.pem --fail --silent https://localhost:10190/healthz
```

リモート公開は `OPENCODEX_BIND_ADDRESS=<LANまたはTailscaleのIP>` で明示的に選択し、`0.0.0.0` は全インターフェースを公開します。生成される証明書が対象とするのは `localhost` と `127.0.0.1` だけです。直接リモート公開する場合は、生成済みの証明書と鍵を正確なリモート名に対応する証明書と鍵に置き換え、`OPENCODEX_PUBLIC_ORIGIN=https://hub.example.com:10100` のように、パス、認証情報、クエリ、フラグメントを含まない正確な HTTPS origin を指定してください。ファイアウォールと認証付き TLS/tailnet フロントエンドで保護します。

保持されている TLS 導入前のボリュームは、次の起動時にボリューム固有の TLS identity と公開ホストポートを使う HTTPS origin へ自動移行されます。独自の証明書パスは保持されます。古い HTTP 専用イメージへ戻す場合は、現行イメージが利用できるうちに hub を停止して TLS 設定だけを削除してから、古いイメージを起動してください。証明書ファイルはボリュームに残してかまいません。

```bash
docker compose down
docker compose run --rm hub bun run src/cli/index.ts config unset tls
# 古いイメージを選択またはビルドしてから hub を再作成する
docker compose up -d
```

コンテナは非 root の `bun` ユーザー、読み取り専用のルートファイルシステムで実行され、公開するのはデータポートだけです。`10101` は公開せず、秘密値を `ARG`、`ENV`、`COPY`、Compose、イメージ履歴、argv に入れないでください。コンテナ内の health/readiness probe が証明書検証を省略できるのは、固定されたコンテナループバックへの接続だけです。外部の受入確認では、コピーした公開証明書またはシステムの信頼ストアを使い、実際に接続する正確なホスト名を必ず検証してください。healthcheck 後にも認証済みカタログと実リクエストを別途確認します。`docker compose down` はボリュームを保持し、`docker compose down --volumes` は設定、認証情報、キーも削除します。

- hub 停止時はオフライン切断できますが、キー失効は未完了のままです。
- 一時障害時だけ検証済み LKG を維持し、認証・スキーマ・サイズ・プロトコル障害でローカルへフォールバックしません。
- `.prev` 復旧では二つのファイルを保持して一時権限付きで再実行します。
- `hub-too-new`/`hub-too-old` が示す古い側を更新してください。書き込み前に拒否されます。
- ペアリングコードは一度限りで、失敗は 429 制限されます。失った場合は再発行します。
- 非ループバック HTTP は `--allow-insecure-http` が必要で、管理トークンは HTTP 送信されません。
- ブラウザーのログアウト/期限切れはデータキーを失効させません。
- `tailscale serve reset` の前に全マッピングを確認してください。
