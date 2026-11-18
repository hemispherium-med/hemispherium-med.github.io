# Посредник для нейросети (Cloudflare Worker)

Сайт обращается к нейросети OpenRouter не напрямую, а через этот посредник.
Ключ OpenRouter хранится только в Cloudflare (секрет `OPENROUTER_API_KEY`) и никогда не попадает в код сайта.

## Что он умеет

`POST /chat` с JSON:

- `{"task": "explain", ...}` — разобрать ошибку в тестовом вопросе;
- `{"task": "ask", ...}` — ответить на вопрос по найденным фрагментам учебников;
- `{"task": "check", ...}` — проверить ответ студента в клинической задаче.

Текст задания для нейросети собирается здесь по шаблону, поэтому посредника нельзя использовать как чат для чего угодно.
`GET /health` показывает, настроен ли ключ (сам ключ не показывает).

## Защита

- запросы принимаются только с адресов из `ALLOWED_ORIGINS`;
- не больше 8 запросов в минуту с одного IP (`[[ratelimits]]` в `wrangler.toml`);
- длина ответа ограничена `MAX_TOKENS`;
- главная страховка — лимит трат на самом ключе в OpenRouter (Settings → API Keys → Credit limit).

## Как развернуть

1. Cloudflare → Workers & Pages → Create → Import a repository → этот репозиторий,
   корневая папка (Root directory / Path): `api`. Cloudflare сам выполнит `npx wrangler deploy`.
2. В настройках воркера: Settings → Variables and Secrets → Add → тип Secret,
   имя `OPENROUTER_API_KEY`, значение — ключ OpenRouter.
3. Адрес воркера (`https://hemispherium-ai.<имя>.workers.dev`) вписать в `AI_URL` в `index.html` сайта.

Модель меняется в `wrangler.toml` (`MODEL`) или в Cloudflare: Settings → Variables.
