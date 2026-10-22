# Сервер общего датасета

Cloudflare Worker + база D1. Принимает метки от тех, кто включил «Делиться разметкой», и отдаёт их на обучение. Бесплатного тарифа хватает с запасом: 100 тыс. запросов в сутки, 5 ГБ базы, а одна метка занимает около 1,2 КБ.

## Развернуть (один раз)

```bash
cd server
npx wrangler login                                   # откроет браузер, вход в аккаунт Cloudflare
npx wrangler d1 create iindu-dataset                 # напечатает database_id — вставь его в wrangler.toml
npx wrangler d1 execute iindu-dataset --remote --file=schema.sql
npx wrangler secret put EXPORT_TOKEN                 # придумай длинный случайный токен: им скачиваешь датасет
npx wrangler deploy                                  # напечатает адрес вида https://iindu-dataset.<аккаунт>.workers.dev
```

Дальше:

1. Адрес сервера вставь в `extension/background.js` в `SHARE_URL`. Без него блок «Делиться разметкой» в попапе скрыт.
2. В `extension/popup.js` в `PRIVACY_URL` замени `ВЛАДЕЛЕЦ/РЕПОЗИТОРИЙ` на свой репозиторий: ссылка ведёт на раздел «Приватность» в README.
3. Проверь, что сервер отвечает: `curl https://…workers.dev/v1/stats` → `{"n":0,"pos":0}`.

## Забрать датасет и переобучить модель

```bash
IINDU_SHARE_URL=https://iindu-dataset.<аккаунт>.workers.dev IINDU_EXPORT_TOKEN=<токен> python3 training/fetch_shared_dataset.py
python3 training/train_scene.py
```

## Адреса

| Метод | Путь | Что делает |
|---|---|---|
| POST | `/v1/labels` | принять до 50 меток `{install, items}`; не больше `DAILY_CAP` (300) в сутки с установки |
| DELETE | `/v1/labels/<install>/<id>` | удалить одну метку («Отменить») |
| DELETE | `/v1/install/<install>` | удалить всё с установки («Удалить мои данные») |
| GET | `/v1/stats` | сколько меток всего |
| GET | `/v1/export?after=N&limit=M` | выгрузка, только с `Authorization: Bearer EXPORT_TOKEN` |

Сервер проверяет формат каждой метки и длину вектора (эмбеддинг CLIP нормирован), поэтому мусор вроде нулевых векторов и чужих сайтов отбрасывается. IP-адреса и заголовки не записываются.

## Локальная проверка

```bash
cd server && echo 'EXPORT_TOKEN=test-token' > .dev.vars
npx wrangler d1 execute iindu-dataset --local --file=schema.sql
npx wrangler dev --local --port 8787
node test/e2e/share.js          # в другом терминале, из корня проекта
```

Тест прогоняет всю цепочку на копии расширения:
1. без согласия ничего не уходит;
2. метки после согласия доходят;
3. «Отменить» удаляет метку на сервере;
4. после отзыва согласия ничего не уходит;
5. «Удалить мои данные» стирает всё.
