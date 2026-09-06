---
title: Remote Hub Dağıtımı
description: Loopback yönetimi, Tailscale Serve ve başsız OAuth ile opencodex hub çalıştırma.
---

Remote Hub sağlayıcı kimlik bilgilerini, kataloğu ve kullanım kayıtlarını tek ana bilgisayarda tutar. Kimliği doğrulanmış istemciler veri düzlemine doğrudan bağlanır. Yönetim düzlemi ayrıdır: isteğe bağlı dinleyici yalnızca `127.0.0.1` üzerinde çalışır ve pano ile `/api/*` yollarını sunar; `/v1/*`, `/healthz`, `/readyz` veya WebSocket sunmaz. `10101` portunu yayımlamayın ve Tailscale Funnel kullanmayın.

## Roller ve güven sınırı

`standalone` her şeyi tek makinede tutar; `hub` sağlayıcı sırları ve kullanımı yönetir; `client` yalnızca bağlantı durumunu ve istemciye özel veri anahtarını saklar.

```bash
ocx connect https://hub-name.tailnet-name.ts.net --pairing-code-stdin
ocx connect status
ocx sync
```

İstemci anahtarı yalnızca sahibinin okuyabildiği `service-api-token` dosyasına yazılır, `config.json` içine yazılmaz. Bağlı kullanım hub deposundan aynı `apiKeyId` ile filtrelenir; bağlantı kesilince yerel depo kullanılır. İki depo birbirini yansıtmaz.

Admin token sıradan yönetim yapabilir ancak hiçbir zaman onay oturumu oluşturamaz. Onay işlemleri sunucu tarafından verilen `gui-session`, eşleşen Origin ve CSRF ister. `Tailscale-User-Login` yalnızca ayrı yönetim girişinde güvenilirdir; tam kimlikleri `remoteGui.allowedTailscaleUsers` içinde belirtin.

## Servis ve Tailscale Serve

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

systemd/launchd korumalı `service-api-token` dosyasını okur; plist veya unit içine gerçek sır yazılmaz.

```bash
curl --fail --silent http://100.64.0.10:10100/healthz
curl --fail --silent http://100.64.0.10:10100/readyz
tailscale serve --bg --https=443 http://127.0.0.1:10101
tailscale serve status
```

`/healthz` yalnızca işlemin yaşadığını gösterir. `/readyz`, kimlik doğrulamalı `GET /v1/catalog` ve gerçek bir model yanıtını da doğrulayın. Kendi TLS proxy'niz için `tailscale cert hub-name.tailnet-name.ts.net` kullanın ve yalnızca `127.0.0.1:10101` hedefine yönlendirin. `Tailscale-User-*` başlıkları uydurmayın; güvenilir kimlik yoksa tek kullanımlık eşleştirme kullanın.

## OAuth, döndürme ve bağlantı kesme

```bash
ocx config set oauthOpenBrowser false
ocx connect rotate --pairing-code-stdin
# yalnızca HTTPS:
ocx connect rotate --admin-token-stdin
```

OAuth'u `POST /api/oauth/login` ile başlatın. Callback hub'a ulaşamıyorsa son URL'yi veya kodu `{provider,input}` olarak `POST /api/oauth/login/code` yoluna gönderin. OAuth kodunu argv veya loglara koymayın.

Döndürme sırasında eski ve yeni anahtar aynı `apiKeyId` altında en fazla on dakika geçerlidir. Eski anahtar `service-api-token.prev` dosyasına alınır, yeni anahtar atomik olarak kurulur ve `/v1/catalog` ile doğrulanıp onaylanır. Sonuç belirsizse geçici yetkiyle komutu yeniden çalıştırın; iki adayı da doğrulamadan silmeyin.

`ocx disconnect` hub çevrimdışıyken yerel durumu geri yükler ama hub anahtarını iptal etmez. Bağlantıdan sonra tek iptal yolu hub üzerindeki **Integrations → API Keys** sayfasıdır. `ocx connect revoke --admin-token-stdin` yalnızca bağlantı sürerken kullanılabilir.

## Docker ve sorun giderme

Resmî Docker imajı yoktur; ancak depo, digest ile sabitlenmiş Bun imajını yerelde oluşturmak için bakımı yapılan bir `Dockerfile` ve `compose.yaml` sağlar. İlk normal başlatma, volume başına kendinden imzalı bir TLS kimliği oluşturur; herkese açık sertifika `/home/bun/.opencodex/container-tls/cert.pem`, özel anahtar ise aynı dizindedir ve yalnızca sahibi tarafından okunabilir. Veri anahtarını ilk başlatmadan önce stdin üzerinden bir kez başlatın. Yardımcı en fazla 512 baytlık tek satır kabul eder, anahtarı yazdırmaz ve `ocx-state` volume içindeki owner-only `service-api-token` dosyasını değiştirmeyi reddeder.

Host üzerinde Git ve Bun gereklidir. Her imaj derlemesinden önce Git tarafından izlenen kaynaklardan kanonik manifesti üretin ve derleme bitene kadar kaynakları değiştirmeyin. Üretilen JSON dosyasını Git'e eklemeyin; `.git` Docker bağlamının dışında kalır. HTTPS host portu varsayılan olarak `127.0.0.1:10100` adresine bağlanır. `OPENCODEX_PORT=10190` hem yayınlanan host portunu hem de yönetilen `tls.publicOrigin` değerini `https://localhost:10190` yapar; konteyner içindeki port yine `10100` kalır.

Manifest; `Dockerfile`, `compose.yaml`, `.dockerignore`, Git tarafından izlenen tüm `docker/` yetki dosyaları, `src/`, `package.json`, `bun.lock` ve `scripts/model-metadata.source.json` dosyalarını doğrular. Derleme her SHA-256 değerini önce bağlamdaki, ardından kopyalanan dosyalardaki baytlarla karşılaştırır; eksik veya uyuşmayan dosyaları, sembolik bağlantıları ve manifestte bulunmayan ek `src/` ya da `docker/` yetki dosyalarını reddeder.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun scripts/generate-compatibility-version.ts
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
```

Varsayılan HTTPS uç noktasını doğrulamak için yalnızca açık sertifikayı dışarı kopyalayın ve CA olarak kullanın:

```bash
mkdir -p .tmp
docker compose cp hub:/home/bun/.opencodex/container-tls/cert.pem .tmp/opencodex-container-ca.pem
curl --cacert .tmp/opencodex-container-ca.pem --fail --silent https://localhost:10100/healthz
```

Konteyner içi liveness/readiness kontrolleri sertifika doğrulamasını yalnızca sabit konteyner loopback hedefinde devre dışı bırakabilir. Harici kabul testleri ise tam host adını kopyalanmış açık sertifika veya sistem güven deposuyla doğrulamalıdır.

Uzak erişim açıkça etkinleştirilmelidir: `OPENCODEX_BIND_ADDRESS=<LAN-veya-Tailscale-IP> docker compose up -d`; `0.0.0.0` tüm arayüzleri açar. Üretilen sertifika yalnızca `localhost` ve `127.0.0.1` için geçerlidir. Yerel yayını koruyup kimlik doğrulamalı bir TLS/tailnet ön ucu kullanın veya uzak ad için özel sertifika/anahtar yollarını ve tam HTTPS `tls.publicOrigin` değerini yayına açmadan önce ayarlayın. Her iki durumda da güvenlik duvarı kullanın.

Saklanan TLS öncesi bir volume, sonraki `docker compose up -d` sırasında volume kimliği ve `OPENCODEX_PORT` tabanlı HTTPS origin eklenerek otomatik taşınır; operatörün özel sertifika yolları korunur. Eski, yalnızca HTTP imajına geri dönmeden önce mevcut imajla yalnızca TLS ayarını kaldırın; kimlik dosyaları volume içinde kalabilir:

```bash
docker compose down
docker compose run --rm hub bun run src/cli/index.ts config unset tls
# eski imajı seçin/derleyin, sonra hub'ı yeniden oluşturun
docker compose up -d
```

Konteyner root olmayan `bun` kullanıcısıyla, salt okunur kök dosya sistemiyle çalışır ve yalnızca `10100` portunu yayımlar. `10101` portunu yayımlamayın ve sırları `ARG`, `ENV`, `COPY`, Compose, imaj geçmişi veya argv içine koymayın. Healthcheck sonrasında HTTPS `/readyz`, kimlik doğrulamalı katalog ve gerçek yanıtı ayrıca doğrulayın. `docker compose down` volume'u korur; `docker compose down --volumes` yapılandırmayı, TLS kimliğini, kimlik bilgilerini ve veri anahtarını da siler.

- Hub kapalıysa yerel geri dönüş yapılabilir; uzaktaki anahtarın iptali bekler.
- Geçici arızada doğrulanmış LKG korunur; auth, şema, boyut veya protokol hatasında yerel fallback yoktur.
- `.prev` kurtarmasında iki dosyayı koruyup geçici yetkiyle yeniden çalıştırın.
- `hub-too-new`/`hub-too-old` eski tarafı gösterir; yerel yazımdan önce reddedilir.
- Eşleştirme tek kullanımlıktır ve hatalar 429 ile sınırlanır; kayıp kodu yeniden üretin.
- Loopback dışı HTTP için `--allow-insecure-http` gerekir; admin token HTTP ile gönderilmez.
- Tarayıcı logout/expiry veri anahtarını iptal etmez.
- `tailscale serve reset` tüm eşlemeleri kaldırır; önce durumu inceleyin.
