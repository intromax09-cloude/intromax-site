# Что осталось по аудиту (требует решения или ключей)

## 8, 9. Защита от спама (Cloudflare Turnstile)
1. Cloudflare Dashboard → Turnstile → создать виджет для intromax.com.ua; получить site key (публичный) и secret key.
2. Secret положить в Pages → Settings → Variables как секрет `TURNSTILE_SECRET` (в репозиторий не коммитить).
3. Фронтенд: подключить `https://challenges.cloudflare.com/turnstile/v0/api.js`, добавить виджет в формы заявки и отзыва, токен отправлять в теле запроса (`cf-turnstile-response`). Для чата проверять токен один раз при старте сессии.
4. `functions/api/lead.js`, `review.js`, `chat.js`: до обработки POST на `https://challenges.cloudflare.com/turnstile/v0/siteverify` (secret + token + IP); при неуспехе — 403. Добавить проверку заголовка `Origin`.
5. Дополнительно: WAF rate limiting rule на `/api/*` (например, 10 запросов/мин с IP).
6. `/api/tick`: добавить общий секрет (заголовок или query `?key=`) в cron-воркере и сверять его в `tick.js`.
7. После подключения добавить `https://challenges.cloudflare.com` в `script-src`, `frame-src` и `connect-src` CSP.

## 11. Three.js без SRI (`import()` с cdn.jsdelivr.net, версия 0.160.0)
- Вариант A: скопировать `three.module.min.js` в `/vendor/` и импортировать со своего домена (убирает внешнюю зависимость, `script-src` можно сузить).
- Вариант B: оставить как есть (версия закреплена, риск низкий); SRI для динамического `import()` недоступен.

## 12. Google Fonts (блокирующий stylesheet)
- Вариант A: самохостинг woff2 (Manrope, Playfair Display, JetBrains Mono) + `@font-face` + `<link rel="preload">`; убирает внешний запрос и упрощает CSP.
- Вариант B: неблокирующая загрузка: `<link rel="stylesheet" media="print" onload="this.media='all'">` + `<noscript>`; шрифты остаются внешними.

## CSP
Сейчас `Content-Security-Policy-Report-Only`. После недели без нарушений в консоли можно перевести в `Content-Security-Policy`; из-за inline-скриптов остаётся `'unsafe-inline'` (строже — nonce/хэши, потребует сборки).
