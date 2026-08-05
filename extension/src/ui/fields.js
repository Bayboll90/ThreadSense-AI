/**
 * Описание всех настраиваемых полей.
 *
 * Форма строится из этого описания, а не верстается руками: полей около сотни,
 * и любая ручная вёрстка неизбежно разъедется со схемой в defaults.js. Здесь
 * же живут человеческие подписи и пояснения — без них половина ползунков
 * непонятна даже автору через месяц.
 *
 * path — путь в объекте настроек через точку.
 * type — text | password | number | range | toggle | textarea | tags | select | pair
 */

import { MODEL_CHOICES, ANGLES } from '../common/defaults.js';
import { PROVIDER_CHOICES } from '../common/providers.js';

export const SCHEMA = {

  /* ------------------------------------------------------------------ */
  ai: [
    {
      title: 'Подключение',
      fields: [
        {
          path: 'ai.provider', type: 'select', label: 'Провайдер', options: PROVIDER_CHOICES,
          hint: 'Выбери платформу. Адрес API и стартовые модели подставятся автоматически; для своего шлюза выбери совместимый API.',
        },
        {
          path: 'ai.apiKey', type: 'password', label: 'Ключ API',
          hint: 'Хранится только в твоём Chrome. Уходит исключительно на адрес из поля ниже.',
          action: { id: 'testKey', label: 'Проверить' },
        },
        {
          path: 'ai.baseUrl', type: 'text', label: 'Адрес API',
          hint: 'Меняй только для прокси, корпоративного шлюза или локального OpenAI-совместимого сервера.',
        },
      ],
    },
    {
      title: 'Свои инструкции',
      fields: [
        { path: 'ai.promptMode', type: 'select', label: 'Как применять мои промпты', options: ['append', 'replace'],
          hint: 'append добавляет инструкции к безопасной основе. replace полностью заменяет системный промпт, но кодовые проверки длины, повторов и запрещённого контента всё равно работают.' },
        { path: 'ai.promptOverrides.relevance', type: 'textarea', rows: 3, label: 'Отбор постов', hint: 'Дополнительная инструкция к системному промпту оценки релевантности.' },
        { path: 'ai.promptOverrides.analysis', type: 'textarea', rows: 3, label: 'Разбор ветки' },
        { path: 'ai.promptOverrides.comment', type: 'textarea', rows: 4, label: 'Комментарии', hint: 'Тон, роль, ограничения и желаемый результат. Встроенные проверки безопасности остаются включены.' },
        { path: 'ai.promptOverrides.reply', type: 'textarea', rows: 3, label: 'Ответы читателям' },
        { path: 'ai.promptOverrides.post', type: 'textarea', rows: 4, label: 'Собственные посты и ветки' },
      ],
    },
    {
      title: 'Модели',
      fields: [
        {
          path: 'ai.modelScore', type: 'select', label: 'Оценка постов', options: MODEL_CHOICES,
          hint: 'Дешёвая модель для батч-оценки релевантности и разбора ветки. Здесь важна цена, а не мощь.',
        },
        {
          path: 'ai.modelWrite', type: 'select', label: 'Написание комментария', options: MODEL_CHOICES,
          hint: 'Модель, которая пишет сам текст. От неё зависит всё качество.',
        },
        {
          path: 'ai.modelStyle', type: 'select', label: 'Разбор твоего стиля', options: MODEL_CHOICES,
          hint: 'Используется один раз при обучении стиля.',
        },
        {
          path: 'ai.twoPass', type: 'toggle', label: 'Два прохода',
          hint: 'Сначала разбор ветки и поиск того, чего в обсуждении не хватает, потом текст. ' +
                'Выключить — обычно дешевле, но разбор контекста станет менее глубоким.',
        },
        {
          path: 'ai.reasoningEffort', type: 'select', label: 'Усилие рассуждения',
          options: ['none', 'low', 'medium', 'high'],
          hint: 'Применяется только к моделям, которые поддерживают этот параметр. Для коротких публикаций обычно достаточно none или low.',
        },
      ],
    },
    {
      title: 'Параметры генерации',
      fields: [
        {
          path: 'ai.temperature', type: 'range', label: 'Температура', min: 0.3, max: 1.6, step: 0.05,
          hint: 'Низкие значения делают ответы стабильнее, высокие — разнообразнее. Подходящий диапазон зависит от выбранной модели.',
        },
        { path: 'ai.topP', type: 'range', label: 'top_p', min: 0.5, max: 1, step: 0.05 },
        {
          path: 'ai.presencePenalty', type: 'range', label: 'Штраф за повтор темы', min: 0, max: 1.5, step: 0.05,
        },
        {
          path: 'ai.frequencyPenalty', type: 'range', label: 'Штраф за повтор слов', min: 0, max: 1.5, step: 0.05,
        },
        { path: 'ai.maxOutputTokens', type: 'number', label: 'Потолок ответа, токенов', min: 60, max: 2000 },
      ],
    },
    {
      title: 'Расходы и надёжность',
      fields: [
        {
          path: 'ai.fallbackChain', type: 'tags', label: 'Запасные модели',
          hint: 'Перегруз или временная недоступность выбранной модели — обычное дело, и сессия ' +
                'не должна из-за этого вставать на сутки. Текст, написанный моделью послабее, ' +
                'лучше отсутствующего. При неверном ключе или исчерпанном счёте перебор не запускается: ' +
                'от модели это не зависит.',
        },
        {
          path: 'ai.dailyBudgetUsd', type: 'number', label: 'Дневной бюджет, $', min: 0.05, max: 50, step: 0.05,
          hint: 'При достижении лимита агент встаёт до полуночи. Фактический расход зависит от моделей, тарифов и объёма контекста.',
        },
        { path: 'ai.defaultPricing.input', type: 'number', label: 'Цена входа, $ / 1 млн токенов', min: 0, max: 1000, step: 0.001,
          hint: 'Используется для моделей, которых нет во встроенном прайсе.' },
        { path: 'ai.defaultPricing.cached', type: 'number', label: 'Цена кешированного входа, $ / 1 млн', min: 0, max: 1000, step: 0.001 },
        { path: 'ai.defaultPricing.output', type: 'number', label: 'Цена выхода, $ / 1 млн токенов', min: 0, max: 1000, step: 0.001 },
        { path: 'ai.requestTimeoutMs', type: 'number', label: 'Таймаут запроса, мс', min: 5000, max: 120000, step: 1000 },
        { path: 'ai.maxRetries', type: 'number', label: 'Повторов при сбое', min: 0, max: 6 },
      ],
    },
  ],

  /* ------------------------------------------------------------------ */
  niche: [
    {
      title: 'Тематика',
      fields: [
        {
          path: 'handle', type: 'text', label: 'Мой хэндл в Threads',
          hint: 'Без собаки. Нужен, чтобы собрать твой стиль и не отвечать самому себе.',
          action: { id: 'detectHandle', label: 'Определить' },
        },
        {
          path: 'niche.description', type: 'textarea', label: 'Описание ниши', rows: 4,
          hint: 'Уходит в промпт как есть. Пиши так, как объяснил бы человеку: что тебе интересно, ' +
                'а что нет. От этого зависит и отбор постов, и содержание ответов.',
        },
        {
          path: 'niche.languages', type: 'tags', label: 'Языки контента',
          hint: 'Коды ru, en и другие. Пустой список не ограничивает язык; для первого запуска лучше указать один основной.',
        },
        {
          path: 'niche.includeKeywords', type: 'tags', label: 'Ключевые слова',
          hint: 'Локальный префильтр: пост без единого совпадения выбрасывается бесплатно, ' +
                'не доходя до ИИ. Пиши корни без окончаний: «фотограф», «путешеств».',
        },
        {
          path: 'niche.excludeKeywords', type: 'tags', label: 'Стоп-слова',
          hint: 'Одно совпадение — пост выбрасывается. Сюда всё конфликтное и рекламное.',
        },
        {
          path: 'niche.blockedAuthors', type: 'tags', label: 'Авторы в игноре',
          hint: 'Хэндлы без собаки.',
        },
      ],
    },
    {
      title: 'Источники постов',
      fields: [
        { path: 'niche.sources.home', type: 'toggle', label: 'Главная лента',
          hint: 'Основной источник: там свежие посты подписок и рекомендации.' },
        { path: 'niche.sources.search', type: 'toggle', label: 'Поиск по фразам' },
        { path: 'niche.sources.tags', type: 'toggle', label: 'Поиск по темам' },
        { path: 'niche.sources.authors', type: 'toggle', label: 'Обход конкретных авторов' },
        {
          path: 'niche.searchQueries', type: 'tags', label: 'Поисковые фразы',
          hint: 'За сессию агент берёт одну случайную. Разнообразие фраз важнее их количества.',
        },
        { path: 'niche.tags', type: 'tags', label: 'Темы' },
        { path: 'niche.authors', type: 'tags', label: 'Авторы для обхода', hint: 'Хэндлы без собаки.' },
      ],
    },
    {
      title: 'Дополнительный источник: GitHub и MCP',
      fields: [
        {
          path: 'tools.enabled', type: 'toggle', label: 'Готовить разборы инструментов',
          hint: 'Опциональный источник для технических ниш. По умолчанию выключен и ничего не загружает.',
        },
        {
          path: 'tools.registryEnabled', type: 'toggle', label: 'Использовать реестр MCP',
          hint: 'Добавляет кандидатов из публичного реестра Model Context Protocol.',
        },
        {
          path: 'tools.githubQueries', type: 'tags', label: 'Запросы GitHub',
          hint: 'Задай поисковые запросы GitHub самостоятельно. Пустой список отключает GitHub-источник.',
        },
        {
          path: 'posting.guidesPerDay', type: 'number', label: 'Разборов в день', min: 0, max: 10,
          hint: 'Ноль отключает отдельные слоты для этого формата.',
        },
      ],
    },
    {
      title: 'Собственные публикации',
      fields: [
        {
          path: 'posting.enabled', type: 'toggle', label: 'Готовить собственные посты',
          hint: 'По умолчанию выключено. В ручном режиме посты попадут в черновики; в автопилоте могут публиковаться самостоятельно.',
        },
        { path: 'posting.perDay', type: 'number', label: 'Постов в день, максимум', min: 0, max: 20 },
        { path: 'posting.startAfterDay', type: 'number', label: 'Начать после дня прогрева', min: 0, max: 60 },
        { path: 'posting.draftsOnly', type: 'toggle', label: 'Посты всегда оставлять черновиками',
          hint: 'Дополнительная защита: действует даже при включённом автопилоте.' },
        { path: 'posting.windowFromHour', type: 'number', label: 'Окно публикаций: с', min: 0, max: 23 },
        { path: 'posting.windowToHour', type: 'number', label: 'Окно публикаций: до', min: 0, max: 23 },
        { path: 'posting.intervalHours', type: 'number', label: 'Интервал между слотами, часы', min: 0.5, max: 24, step: 0.5 },
        { path: 'posting.image.enabled', type: 'toggle', label: 'Добавлять локальную карточку к разборам' },
        { path: 'posting.setTopic', type: 'toggle', label: 'Ставить тему Threads',
          hint: 'Тема выбирается только из списка «Темы» выше.' },
        { path: 'posting.sourceUrl', type: 'text', label: 'Дополнительный URL материалов',
          hint: 'Оставьте пустым, если внешний источник не нужен. Для удалённого источника используйте HTTPS.' },
        { path: 'posting.sourceToken', type: 'password', label: 'Токен источника материалов',
          hint: 'Хранится локально. Не включается в публичные шаблоны; экспорт настроек очищает его.' },
      ],
    },
    {
      title: 'Разговор под своими постами',
      fields: [
        {
          path: 'hosting.enabled', type: 'toggle', label: 'Отвечать тем, кто написал',
          hint: 'Агент заходит в свой профиль, читает ответы под своими постами и отвечает. ' +
                'Человек, который потрудился ответить, — самый вероятный будущий читатель, ' +
                'а стоит он одного запроса к модели.',
        },
        {
          path: 'hosting.everyMin', type: 'number', label: 'Заглядывать раз в, минут', min: 10, max: 240,
          hint: 'Чаще — значит ходить кругами по странице, где ничего не изменилось.',
        },
        {
          path: 'hosting.maxPerDay', type: 'number', label: 'Ответов своим в день', min: 0, max: 100,
          hint: 'Считается отдельно от комментариев в чужих ветках: под своим постом отвечать — норма, а не риск.',
        },
        {
          path: 'hosting.minReplyLen', type: 'number', label: 'Не отвечать короче, символов', min: 0, max: 100,
          hint: 'На «+» и «согласен» отвечают лайком. Развёрнутый ответ на «+» выглядит натужно.',
        },
        {
          path: 'hosting.maxPostAgeHours', type: 'number', label: 'Возраст поста, часы', min: 2, max: 168,
          hint: 'Ответ через сутки после реплики читается не вниманием, а обходом по списку.',
        },
      ],
    },
    {
      title: 'Обучение на своих результатах',
      fields: [
        {
          path: 'learning.enabled', type: 'toggle', label: 'Учиться на отклике',
          hint: 'Агент смотрит, что вышло из его постов, и сам делает больше тех форматов, ' +
                'на которые отвечают. Данные не заменяют заданные веса, а наклоняют их ' +
                'в границах, так что ни один формат не исчезает.',
        },
        {
          path: 'learning.minPosts', type: 'number', label: 'Не учиться раньше, постов', min: 4, max: 100,
          hint: 'До этого числа любые различия между форматами — шум.',
        },
        {
          path: 'learning.priorStrength', type: 'number', label: 'Сила априора, постов', min: 1, max: 50,
          hint: 'Сколько постов формата нужно, чтобы поверить его собственной доле наполовину. ' +
                'Подобрано перебором: меньшие значения дают вчетверо больше ошибочных наклонов.',
        },
        {
          path: 'learning.halfLifeDays', type: 'number', label: 'Полураспад данных, дни', min: 1, max: 90,
          hint: 'Пост двухнедельной давности весит вдвое меньше вчерашнего.',
        },
        {
          path: 'learning.maxShift', type: 'number', label: 'Предел поправки, раз', min: 1, max: 5, step: 0.1,
          hint: 'Двойка — коридор от половины до двух. Границы гарантируют, что ни один ' +
                'формат не пропадёт: это и есть встроенное исследование.',
        },
      ],
    },
    {
      title: 'Что обсуждают прямо сейчас',
      fields: [
        {
          path: 'trends.enabled', type: 'toggle', label: 'Читать темы из ленты',
          hint: 'Агент запоминает всё, что видит при сканировании, и определяет, какие темы ' +
                'разгораются. Повод для собственного поста берётся оттуда, а не только из новостей. ' +
                'Ничего не стоит: ни запросов к ИИ, ни лишних переходов.',
        },
        {
          path: 'trends.preferOverNews', type: 'toggle', label: 'Лента важнее новостей',
          hint: 'Когда в нише что-то обсуждают — писать об этом, а к новостным лентам обращаться, ' +
                'только если обсуждать нечего.',
        },
        {
          path: 'trends.feedQueries', type: 'toggle', label: 'Искать по разгоревшимся темам',
          hint: 'Половина поисковых заходов идёт по темам, которые агент нашёл сам, половина — ' +
                'по твоим фразам. Твои держат нишу, найденные догоняют то, чего в списке нет.',
        },
        {
          path: 'trends.hotHours', type: 'number', label: 'Окно «сейчас», часы', min: 2, max: 24,
          hint: 'С чем сравнивается свежая доля темы. Меньше — острее реакция и больше шума.',
        },
        {
          path: 'trends.windowHours', type: 'number', label: 'Глубина памяти, часы', min: 6, max: 168,
          hint: 'Сколько держим наблюдения. Это фон, относительно которого считается всплеск.',
        },
        {
          path: 'trends.minAuthors', type: 'number', label: 'Минимум авторов на тему', min: 1, max: 10,
          hint: 'Тема, о которой пишет один человек, — это не тема, а автор.',
        },
      ],
    },
  ],

  /* ------------------------------------------------------------------ */
  filters: [
    {
      title: 'Что вообще не рассматривать',
      fields: [
        {
          path: 'filters.minTextLen', type: 'number', label: 'Минимум символов в посте', min: 5, max: 500,
          hint: 'Короткий пост не даёт зацепки: отвечать не на что.',
        },
        { path: 'filters.maxTextLen', type: 'number', label: 'Максимум символов', min: 200, max: 10000 },
        {
          path: 'filters.skipMedia', type: 'toggle', label: 'Пропускать посты с медиа',
          hint: 'Из ленты выпадут все посты с картинками и видео. Для многих ниш это режет выборку вдвое — включай, только если комментарии под медиа у тебя не заходят.',
        },
        { path: 'filters.maxAgeHours', type: 'number', label: 'Максимальный возраст, часы', min: 1, max: 720 },
        {
          path: 'filters.minAgeMinutes', type: 'number', label: 'Минимальный возраст, минуты', min: 0, max: 240,
          hint: 'В первые минуты в ветке ещё нет обсуждения.',
        },
      ],
    },
    {
      title: 'Пороги по метрикам',
      fields: [
        {
          path: 'filters.minLikes', type: 'number', label: 'Минимум лайков', min: 0, max: 10000,
          hint: 'Применяется только когда счётчик действительно прочитан. Threads показывает его не всегда, и путать «ноль» со «скрыт» значит выбрасывать половину годной ленты.',
        },
        { path: 'filters.minReplies', type: 'number', label: 'Минимум ответов', min: 0, max: 1000 },
        {
          path: 'filters.skipCold', type: 'toggle', label: 'Пропускать остывшие',
          hint: 'Пост, который за часы не набрал реакции, уже не покажут. Отсев здесь бесплатен, а после генерации — нет.',
        },
        {
          path: 'filters.hotOnly', type: 'toggle', label: 'Только разгоняющиеся',
          hint: 'Жёсткий режим: берём исключительно посты с растущим импульсом. Кандидатов будет мало, зато каждый на пике показов.',
        },
      ],
    },
  ],

  /* ------------------------------------------------------------------ */
  momentum: [
    {
      title: 'Ранний импульс',
      fields: [
        {
          path: 'momentum.earlyAgeHours', type: 'range', label: 'Окно «свежий», часы', min: 0.5, max: 6, step: 0.25,
          hint: 'В этом окне достаточно слабого сигнала, чтобы счесть пост разгоняющимся.',
        },
        { path: 'momentum.earlyLikes', type: 'number', label: 'Лайков достаточно', min: 1, max: 100 },
        { path: 'momentum.earlyReplies', type: 'number', label: 'Ответов достаточно', min: 1, max: 50 },
        { path: 'momentum.earlyPerHour', type: 'number', label: 'Очков в час достаточно', min: 1, max: 100 },
      ],
    },
    {
      title: 'Сильная реакция',
      fields: [
        { path: 'momentum.strongAgeHours', type: 'range', label: 'Окно, часы', min: 1, max: 24, step: 0.5 },
        {
          path: 'momentum.strongScore', type: 'number', label: 'Очков', min: 5, max: 500,
          hint: 'Очки = лайки + ответы×3 + репосты×4. Веса отражают, сколько усилий стоит каждое действие.',
        },
        { path: 'momentum.strongPerHour', type: 'number', label: 'Очков в час', min: 1, max: 200 },
        { path: 'momentum.strongReplies', type: 'number', label: 'Ответов', min: 1, max: 100 },
      ],
    },
    {
      title: 'Крупный пост независимо от возраста',
      fields: [
        { path: 'momentum.absLikes', type: 'number', label: 'Лайков', min: 10, max: 100000 },
        { path: 'momentum.absReplies', type: 'number', label: 'Ответов', min: 5, max: 10000 },
        { path: 'momentum.absScore', type: 'number', label: 'Очков', min: 20, max: 100000 },
      ],
    },
    {
      title: 'Когда считать остывшим',
      fields: [
        { path: 'momentum.deadAgeHours', type: 'range', label: 'Нет реакции спустя, часы', min: 0.5, max: 12, step: 0.5 },
        { path: 'momentum.weakAgeHours', type: 'range', label: 'Слабый старт спустя, часы', min: 1, max: 24, step: 0.5 },
        { path: 'momentum.weakScore', type: 'number', label: 'Слабый старт: очков меньше', min: 1, max: 50 },
        { path: 'momentum.fadedAgeHours', type: 'range', label: 'Затухание спустя, часы', min: 4, max: 72, step: 1 },
        { path: 'momentum.fadedScore', type: 'number', label: 'Затухание: очков меньше', min: 1, max: 100 },
      ],
    },
  ],

  /* ------------------------------------------------------------------ */
  scoring: [
    {
      title: 'Веса компонентов',
      fields: [
        {
          path: 'scoring.weights.relevance', type: 'range', label: 'Релевантность', min: 0, max: 2, step: 0.05,
          hint: 'Попадание в нишу по оценке ИИ. Главный вес, снижать не стоит.',
        },
        {
          path: 'scoring.weights.freshness', type: 'range', label: 'Свежесть', min: 0, max: 2, step: 0.05,
          hint: 'exp(−возраст/τ). Под старым постом комментарий никто не увидит.',
        },
        {
          path: 'scoring.weights.engagement', type: 'range', label: 'Живость', min: 0, max: 2, step: 0.05,
          hint: 'Лайки по логарифмической шкале — иначе один вирусный пост забивает весь отбор.',
        },
        {
          path: 'scoring.weights.opportunity', type: 'range', label: 'Шанс быть замеченным', min: 0, max: 2, step: 0.05,
          hint: 'Живость, делённая на число ответов. Ищет посты, где обсуждение уже началось, ' +
                'но твой комментарий не станет сорок седьмым.',
        },
        {
          path: 'scoring.weights.momentum', type: 'range', label: 'Импульс', min: 0, max: 2, step: 0.05,
          hint: 'Скорость набора реакции, а не её количество. Пост с сорока лайками за двадцать минут ' +
                'и такой же за двенадцать часов одинаковы по счётчикам, но первый показывают прямо сейчас.',
        },
        {
          path: 'scoring.weights.authorValue', type: 'range', label: 'Вес автора', min: -1, max: 2, step: 0.05,
          hint: 'Размер аудитории. Уведи в минус, если хочешь работать по мелким авторам — ' +
                'там ниже конкуренция и выше шанс на диалог.',
        },
        {
          path: 'scoring.weights.risk', type: 'range', label: 'Штраф за риск', min: 0, max: 3, step: 0.05,
          hint: 'Вычитается. Реклама, ссылки, стена хэштегов, капслок, стоп-слова ниши.',
        },
      ],
    },
    {
      title: 'Пороги и параметры',
      fields: [
        {
          path: 'scoring.minScore', type: 'range', label: 'Минимальный скор', min: 0, max: 1, step: 0.01,
          hint: 'Ниже — не комментируем. Поднимай, если качество целей не устраивает.',
        },
        {
          path: 'scoring.minRelevance', type: 'range', label: 'Минимальная релевантность', min: 0, max: 1, step: 0.01,
          hint: 'Жёсткая отсечка по оценке ИИ, независимо от остальных компонентов.',
        },
        {
          path: 'scoring.tauMinutes', type: 'number', label: 'τ свежести, минуты', min: 15, max: 1440,
          hint: 'За τ минут свежесть падает в e раз. 180 — пост живёт около трёх часов.',
        },
        { path: 'scoring.minAgeMinutes', type: 'number', label: 'Минимальный возраст, минуты', min: 0, max: 60,
          hint: 'Под совсем свежим постом ещё нет обсуждения, не от чего оттолкнуться.' },
        { path: 'scoring.maxAgeHours', type: 'number', label: 'Максимальный возраст, часы', min: 1, max: 168 },
        {
          path: 'scoring.topK', type: 'number', label: 'Размер пула выбора', min: 1, max: 20,
          hint: 'Из скольких лучших кандидатов тянется цель.',
        },
        {
          path: 'scoring.softmaxT', type: 'range', label: 'Температура выбора', min: 0.05, max: 1.5, step: 0.05,
          hint: 'Цель выбирается не максимумом, а softmax по скору. При нуле агент всегда берёт лучший ' +
                'пост — и вечно комментирует одних и тех же авторов, что само по себе паттерн.',
        },
        {
          path: 'scoring.batchSize', type: 'number', label: 'Постов в одном батче', min: 5, max: 40,
          hint: 'Больше — дешевле за пост, но выше шанс, что модель собьётся с нумерацией.',
        },
        { path: 'scoring.scanLimit', type: 'number', label: 'Максимум постов за скан', min: 10, max: 150 },
        { path: 'scoring.likesCap', type: 'number', label: 'Потолок лайков для нормировки', min: 50, max: 100000 },
        { path: 'scoring.replyScarcityK', type: 'number', label: 'k дефицита ответов', min: 1, max: 40,
          hint: 'Чем больше, тем мягче падает шанс с ростом числа ответов.' },
        { path: 'scoring.followersCap', type: 'number', label: 'Потолок подписчиков', min: 1000, max: 5000000 },
      ],
    },
  ],

  /* ------------------------------------------------------------------ */
  style: [
    {
      title: 'Профиль стиля',
      fields: [
        {
          path: 'style.profileText', type: 'textarea', label: 'Как я пишу', rows: 7,
          hint: 'Уходит в системный промпт. Заполняется кнопкой «Обучить», дальше правь руками — ' +
                'ты знаешь свою манеру лучше любой модели.',
        },
        {
          path: 'style.examples', type: 'tags', label: 'Примеры моих комментариев',
          hint: 'Модель копирует именно их ритм. Шесть штук берутся случайно на каждую генерацию, ' +
                'чтобы выход не сходился к одному шаблону. ' +
                'Если аккаунт новый и ответов в профиле ещё нет, это главный рычаг качества: ' +
                'впиши сюда 8–15 комментариев так, как написал бы их сам. ' +
                'Обучение по постам даёт «постовой» тон, который под чужой веткой читается скованно.',
        },
        {
          path: 'style.fillers', type: 'tags', label: 'Слова-паразиты',
          hint: 'Гуманизатор вставляет их с заданной вероятностью.',
        },
        {
          path: 'style.emojis', type: 'tags', label: 'Мои эмодзи',
          hint: 'Пусто — не вставлять вообще.',
        },
        {
          path: 'style.bannedPhrases', type: 'tags', label: 'Запрещённые обороты',
          hint: 'Попадают в промпт как чёрный список и вычищаются постфактум. ' +
                'Абстрактное «пиши естественно» модель игнорирует, конкретный список — работает.',
        },
      ],
    },
    {
      title: 'Длина',
      fields: [
        { path: 'style.minLen', type: 'number', label: 'Минимум, символов', min: 10, max: 200 },
        { path: 'style.targetLen', type: 'number', label: 'Цель, символов', min: 30, max: 400 },
        { path: 'style.maxLen', type: 'number', label: 'Максимум, символов', min: 40, max: 500,
          hint: 'Длинный комментарий под чужим постом читается как реклама. Держи в пределах двух фраз.' },
        { path: 'posting.maxLen', type: 'number', label: 'Максимум для своих постов', min: 60, max: 500,
          hint: 'Потолок поверх всех форматов; Threads принимает до 500. Каждый формат целится в свой '
            + 'диапазон, поэтому этот параметр не удлиняет короткие заготовки.' },
      ],
    },
  ],

  /* ------------------------------------------------------------------ */
  humanize: [
    {
      title: 'Общее',
      fields: [
        { path: 'humanize.enabled', type: 'toggle', label: 'Включить гуманизацию' },
      ],
    },
    {
      title: 'Снятие следов ИИ',
      fields: [
        {
          path: 'humanize.killEmDash', type: 'range', label: 'Убирать длинное тире', min: 0, max: 1, step: 0.05,
          hint: 'Главный опознавательный знак сгенерированного текста. Держи на единице.',
        },
        { path: 'humanize.killCliches', type: 'range', label: 'Вычищать штампы', min: 0, max: 1, step: 0.05,
          hint: 'Убирает обороты из списка запрещённых, если модель их всё-таки вставила.' },
        { path: 'humanize.normalizeEllipsis', type: 'range', label: 'Многоточие в три точки', min: 0, max: 1, step: 0.05 },
      ],
    },
    {
      title: 'Пунктуация и регистр',
      fields: [
        { path: 'humanize.lowercaseStart', type: 'range', label: 'Строчная буква в начале', min: 0, max: 1, step: 0.05 },
        { path: 'humanize.dropFinalPeriod', type: 'range', label: 'Без точки в конце', min: 0, max: 1, step: 0.05,
          hint: 'Очень характерно для соцсетей: точка в конце короткой реплики выглядит формально.' },
        { path: 'humanize.yoToE', type: 'range', label: 'Заменять ё на е', min: 0, max: 1, step: 0.05 },
        { path: 'humanize.missingSpaceAfterComma', type: 'range', label: 'Пропуск пробела после запятой', min: 0, max: 0.4, step: 0.01 },
        { path: 'humanize.spaceBeforePunct', type: 'range', label: 'Лишний пробел перед знаком', min: 0, max: 0.3, step: 0.01 },
      ],
    },
    {
      title: 'Опечатки',
      fields: [
        {
          path: 'humanize.typoPerWord', type: 'range', label: 'Вероятность на слово', min: 0, max: 0.2, step: 0.005,
          hint: '0.035 — примерно одна опечатка на тридцать слов. Выше 0.08 текст начинает выглядеть неряшливо.',
        },
        { path: 'humanize.typoMaxPerComment', type: 'number', label: 'Максимум на комментарий', min: 0, max: 5 },
        { path: 'humanize.typoMinWordLen', type: 'number', label: 'Минимальная длина слова', min: 3, max: 10 },
        { path: 'humanize.typoMix.swap', type: 'range', label: 'Доля: перестановка букв', min: 0, max: 1, step: 0.05 },
        { path: 'humanize.typoMix.drop', type: 'range', label: 'Доля: пропуск буквы', min: 0, max: 1, step: 0.05 },
        { path: 'humanize.typoMix.double', type: 'range', label: 'Доля: дубль буквы', min: 0, max: 1, step: 0.05 },
        {
          path: 'humanize.typoMix.neighbor', type: 'range', label: 'Доля: соседняя клавиша', min: 0, max: 1, step: 0.05,
          hint: 'Самый достоверный тип: буква с соседней клавиши по ЙЦУКЕН, как при реальном промахе пальца.',
        },
      ],
    },
    {
      title: 'Разговорность',
      fields: [
        { path: 'humanize.stretchVowel', type: 'range', label: 'Растянуть гласную', min: 0, max: 0.4, step: 0.01,
          hint: '«нуууу», «ваще».' },
        { path: 'humanize.insertFiller', type: 'range', label: 'Вставить слово-паразит', min: 0, max: 0.6, step: 0.01 },
        { path: 'humanize.addEmoji', type: 'range', label: 'Добавить эмодзи', min: 0, max: 1, step: 0.05 },
      ],
    },
  ],

  /* ------------------------------------------------------------------ */
  angles: [
    {
      title: 'Веса углов',
      fields: Object.entries(ANGLES).map(([key, a]) => ({
        path: `angles.weights.${key}`, type: 'range', label: a.label,
        min: 0, max: 40, step: 1, hint: a.hint,
      })),
    },
    {
      title: 'Защита от однообразия',
      fields: [
        {
          path: 'angles.antiRepeatWindow', type: 'number', label: 'Окно памяти, углов', min: 0, max: 40,
          hint: 'Сколько последних углов помним, чтобы приглушать повторы.',
        },
        {
          path: 'angles.repeatPenalty', type: 'range', label: 'Множитель для повтора', min: 0, max: 1, step: 0.05,
          hint: 'Без этого агент незаметно скатывается в один режим — обычно в «согласиться и дополнить», ' +
                'потому что он безопаснее всего звучит для модели.',
        },
        { path: 'angles.allowAiOverride', type: 'toggle', label: 'Разрешить ИИ выбрать угол',
          hint: 'Первый проход может предложить свой заход, если видит очевидно лучший.' },
      ],
    },
  ],

  /* ------------------------------------------------------------------ */
  timing: [
    {
      title: 'Сессия',
      fields: [
        { path: 'timing.sessionMinActions', type: 'number', label: 'Действий минимум', min: 0, max: 20 },
        { path: 'timing.sessionMaxActions', type: 'number', label: 'Действий максимум', min: 1, max: 30 },
        { path: 'timing.sessionMinMinutes', type: 'number', label: 'Длительность минимум, мин', min: 2, max: 120 },
        { path: 'timing.sessionMaxMinutes', type: 'number', label: 'Длительность максимум, мин', min: 5, max: 240 },
      ],
    },
    {
      title: 'Паузы внутри сессии',
      fields: [
        {
          path: 'timing.inSessionMeanSec', type: 'number', label: 'Среднее, секунды', min: 20, max: 3600,
          hint: 'Пауза берётся из экспоненциального распределения с этим средним. Пуассоновский поток ' +
                'событий, а не таймер: интервалы получаются разной длины, как у человека.',
        },
        { path: 'timing.inSessionMinSec', type: 'number', label: 'Минимум, секунды', min: 10, max: 1800 },
        { path: 'timing.inSessionMaxSec', type: 'number', label: 'Максимум, секунды', min: 30, max: 7200 },
      ],
    },
    {
      title: 'Перерывы между сессиями',
      fields: [
        { path: 'timing.breakMeanMinutes', type: 'number', label: 'Среднее, минуты', min: 5, max: 720 },
        { path: 'timing.breakMinMinutes', type: 'number', label: 'Минимум, минуты', min: 2, max: 480 },
        { path: 'timing.breakMaxMinutes', type: 'number', label: 'Максимум, минуты', min: 10, max: 1440 },
      ],
    },
    {
      title: 'Окно активности',
      fields: [
        { path: 'timing.activeFrom', type: 'number', label: 'Начало, час', min: 0, max: 23 },
        { path: 'timing.activeTo', type: 'number', label: 'Конец, час', min: 0, max: 24,
          hint: 'Если конец меньше начала, окно считается переходящим через полночь.' },
        { path: 'timing.tickSec', type: 'number', label: 'Период опроса, секунды', min: 5, max: 120,
          hint: 'Как часто агент проверяет, не пора ли действовать. На частоту действий не влияет.' },
      ],
    },
  ],

  /* ------------------------------------------------------------------ */
  limits: [
    {
      title: 'Потолки',
      fields: [
        {
          path: 'limits.perDay', type: 'number', label: 'Комментариев в день', min: 1, max: 200,
          hint: 'Базовое значение. Фактический лимит разыгрывается каждые сутки заново вокруг него.',
        },
        { path: 'limits.perHour', type: 'number', label: 'Комментариев в час', min: 1, max: 40 },
        {
          path: 'limits.dailyJitter', type: 'range', label: 'Разброс дневного лимита', min: 0, max: 0.6, step: 0.01,
          hint: 'Ровно одинаковое число каждый день — подпись счётчика, а не человека. ' +
                'При 0.25 лимит гуляет в пределах ±25%.',
        },
      ],
    },
    {
      title: 'Прогрев',
      fields: [
        {
          path: 'limits.warmupDays', type: 'number', label: 'Дней прогрева', min: 0, max: 60,
          hint: 'Лимит растёт линейно от стартового к целевому. Аккаунт, который вчера комментировал ноль раз, ' +
                'а сегодня сорок, ловится тривиальным пороговым правилом.',
        },
        { path: 'limits.warmupStartPerDay', type: 'number', label: 'Лимит в первый день', min: 1, max: 50 },
      ],
    },
    {
      title: 'Поведенческий камуфляж',
      fields: [
        {
          path: 'limits.viewsPerComment', type: 'number', label: 'Просмотров на комментарий', min: 0, max: 60,
          hint: 'Аккаунт, который только пишет и ничего не читает, аномален по любой поведенческой метрике.',
        },
        { path: 'limits.likesPerComment', type: 'number', label: 'Лайков на комментарий', min: 0, max: 20, step: 0.1 },
        { path: 'limits.likeWithoutCommentChance', type: 'range', label: 'Шанс лайкнуть и уйти', min: 0, max: 1, step: 0.05 },
        {
          path: 'limits.idleSessionChance', type: 'range', label: 'Шанс холостой сессии', min: 0, max: 1, step: 0.05,
          hint: 'Сессия, в которой агент только листает ленту и ничего не пишет.',
        },
        {
          path: 'limits.abandonAfterOpenChance', type: 'range', label: 'Шанс передумать', min: 0, max: 0.6, step: 0.01,
          hint: 'Открыл пост, прочитал и ушёл, ничего не написав. Так делают все.',
        },
        { path: 'limits.authorCooldownHours', type: 'number', label: 'Кулдаун на автора, часы', min: 0, max: 336,
          hint: 'Не комментировать одного человека чаще, чем раз в столько часов.' },
        { path: 'limits.maxPerThread', type: 'number', label: 'Комментариев в одну ветку', min: 1, max: 3 },
      ],
    },
  ],

  /* ------------------------------------------------------------------ */
  typing: [
    {
      title: 'Скорость',
      fields: [
        {
          path: 'typing.wpm', type: 'range', label: 'Слов в минуту', min: 20, max: 130, step: 1,
          hint: 'Средний пользователь — 40–70. Комментарий на 150 символов будет набираться около 30 секунд.',
        },
        {
          path: 'typing.cv', type: 'range', label: 'Разброс ритма', min: 0.2, max: 1.2, step: 0.05,
          hint: 'Интервалы между символами берутся из логнормального распределения: плотное ядро на ' +
                'привычных сочетаниях и длинный хвост на паузах.',
        },
        { path: 'typing.spaceFactor', type: 'range', label: 'Замедление на пробеле', min: 1, max: 2.5, step: 0.05 },
        { path: 'typing.minCharMs', type: 'number', label: 'Минимум на символ, мс', min: 10, max: 200 },
        { path: 'typing.maxCharMs', type: 'number', label: 'Максимум на символ, мс', min: 200, max: 3000 },
      ],
    },
    {
      title: 'Человеческие сбои',
      fields: [
        {
          path: 'typing.thinkChance', type: 'range', label: 'Задуматься посреди фразы', min: 0, max: 0.2, step: 0.005,
        },
        {
          path: 'typing.typoChance', type: 'range', label: 'Промах по клавише', min: 0, max: 0.12, step: 0.002,
          hint: 'Печатает соседний символ, замечает через пару знаков и исправляет бэкспейсом. ' +
                'Это опечатки в процессе набора — отдельно от опечаток, которые остаются в готовом тексте.',
        },
      ],
    },
  ],

  /* ------------------------------------------------------------------ */
  safety: [
    {
      title: 'Фильтры текста',
      fields: [
        { path: 'safety.stopWords', type: 'tags', label: 'Стоп-слова',
          hint: 'Комментарий с любым из них бракуется целиком.' },
        { path: 'safety.banLinks', type: 'toggle', label: 'Запретить ссылки',
          hint: 'Ссылки в комментариях от неразогретого аккаунта — прямой путь к ограничениям.' },
        { path: 'safety.banMentions', type: 'toggle', label: 'Запретить @-упоминания' },
        { path: 'safety.banHashtags', type: 'toggle', label: 'Запретить хэштеги' },
      ],
    },
    {
      title: 'Защита от повторов',
      fields: [
        {
          path: 'safety.similarityThreshold', type: 'range', label: 'Порог схожести', min: 0.1, max: 0.9, step: 0.01,
          hint: 'Триграммный Жаккар против последних комментариев. Выше порога — регенерация. ' +
                'Повторяющиеся формулировки платформа группирует тривиально.',
        },
        { path: 'safety.similarityWindow', type: 'number', label: 'Окно сравнения', min: 5, max: 60 },
        { path: 'safety.maxRegen', type: 'number', label: 'Попыток перегенерации', min: 0, max: 5 },
      ],
    },
    {
      title: 'Реакция на сигналы',
      fields: [
        {
          path: 'safety.onBlockPauseHours', type: 'number', label: 'Пауза при ограничении, часы', min: 1, max: 168,
          hint: 'Когда Threads показывает «Действие заблокировано». Продолжать работу после первого ' +
                'такого сигнала — самый быстрый способ превратить временное ограничение в постоянное.',
        },
        { path: 'safety.shadowFailThreshold', type: 'number', label: 'Неподтверждённых подряд', min: 1, max: 10,
          hint: 'Отправка прошла, а комментарий в ветке не появился. Столько раз подряд — стоп.' },
        { path: 'safety.onShadowFailPauseHours', type: 'number', label: 'Пауза при этом, часы', min: 1, max: 72 },
        { path: 'safety.breakerThreshold', type: 'number', label: 'Ошибок до предохранителя', min: 1, max: 10 },
        { path: 'safety.breakerCooldownMinutes', type: 'number', label: 'Пауза предохранителя, минуты', min: 5, max: 480 },
        { path: 'safety.hardStopOnChallenge', type: 'toggle', label: 'Полный стоп при проверке аккаунта',
          hint: 'Капча, запрос кода, подозрительная активность. Продолжать нельзя ни при каких условиях.' },
        { path: 'safety.notify', type: 'toggle', label: 'Уведомления Chrome' },
      ],
    },
    {
      title: 'Живучесть',
      fields: [
        {
          path: 'safety.singleTab', type: 'toggle', label: 'Работать только в одной вкладке',
          hint: 'Две открытые вкладки Threads означают двух агентов: счётчики общие, а реальная ' +
                'нагрузка на аккаунт удваивается. Право действовать арендуется одной вкладкой.',
        },
        {
          path: 'safety.keepaliveAudio', type: 'toggle', label: 'Неслышимый звук против троттлинга',
          hint: 'Chrome душит таймеры в неактивной вкладке, растягивая паузы в разы. Осциллятор на ' +
                'громкости 0.0008 не слышен ни на каком оборудовании, но вкладку удерживает активной.',
        },
        {
          path: 'safety.watchdogEnabled', type: 'toggle', label: 'Сторожевой таймер',
          hint: 'Если скрипт на странице замолчал дольше восьми минут, вкладка перезагружается. ' +
                'Зависание изнутри не поймать — снаружи это просто отсутствие пульса.',
        },
        {
          path: 'safety.technicalStreakLimit', type: 'number', label: 'Сбоев подряд до эскалации', min: 1, max: 10,
          hint: 'Не нашлась кнопка, не открылось поле, не прошла отправка. Столько раз подряд — ' +
                'значит дело не в постах, и агент поднимается по лестнице восстановления: ' +
                'вернуться в ленту → перезагрузить страницу → остановиться.',
        },
      ],
    },
    {
      title: 'Ритм жизни',
      fields: [
        {
          path: 'rhythm.enabled', type: 'toggle', label: 'Разный распорядок по дням',
          hint: 'Подъём и отбой плавают, часть дней почти пустые, день разорван отлучками. ' +
                'Выключено — окно активности стоит неподвижно, и все сутки выходят одинаковыми.',
        },
        {
          path: 'rhythm.driftHours', type: 'number', label: 'Разброс подъёма и отбоя, часы', min: 0, max: 5, step: 0.5,
        },
        {
          path: 'rhythm.offDayChance', type: 'number', label: 'Доля пустых дней', min: 0, max: 0.5, step: 0.01,
          hint: 'В такой день агент заглядывает один раз на час-полтора и почти ничего не пишет. ' +
                'Ноль — работать каждый день без исключений.',
        },
        { path: 'rhythm.gapsMin', type: 'number', label: 'Отлучек в день, минимум', min: 0, max: 5 },
        { path: 'rhythm.gapsMax', type: 'number', label: 'Отлучек в день, максимум', min: 0, max: 6 },
        { path: 'rhythm.gapMinMinutes', type: 'number', label: 'Длина отлучки, минимум, мин', min: 10, max: 240 },
        { path: 'rhythm.gapMaxMinutes', type: 'number', label: 'Длина отлучки, максимум, мин', min: 20, max: 400 },
      ],
    },
    {
      title: 'Интерфейс и журнал',
      fields: [
        {
          path: 'ui.overlay', type: 'select', label: 'Где показывать состояние',
          options: ['window', 'page', 'off'],
          hint: 'window — отдельное окошко расширения: в DOM Threads ничего не добавляется, ' +
                'а состояние остаётся видимым отдельно. page — плашка прямо на странице; ' +
                'off — только журнал и popup.',
        },
        { path: 'ui.logSize', type: 'number', label: 'Размер журнала', min: 50, max: 2000 },
      ],
    },
  ],
};
