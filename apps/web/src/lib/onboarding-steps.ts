/** One step of the guided tour: where to go, what to point at, what to say. */
export interface OnboardingStep {
  id: string
  route: string
  /** Element to highlight; null for a plain card (the finish, or a part that may be absent). */
  selector: string | null
  /** The same place on a phone, where the bottom tabs replace the top bar and the bell. */
  mobileSelector?: string | null
  title: string
  text: string
  /** Runs before the element is looked up: opens the truck card, the AI dispatcher window … */
  prepare?: 'open-card' | 'open-assistant'
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  { id: 'nav', route: '/', selector: 'nav[aria-label="Основная навигация"]', mobileSelector: 'nav.mobile-tabbar', title: 'Разделы программы',
    text: 'Диспозиция — карта и машины. Auftrag — загрузка заказов. Машины, Туры, Статус 07:00, Аналитика и Настройки — остальные разделы. Текущий раздел подсвечен.' },
  { id: 'fleet', route: '/', selector: 'aside[aria-label="Список грузовиков"]', title: 'Список машин',
    text: 'Каждая строка — машина с её состоянием, следующей точкой и ETA. Поиск находит по номеру LKW, Auftrag или городу. Фильтры сверху отбирают по состоянию, «Мои / Свободные / Все» — чьи машины показывать.' },
  { id: 'decisions', route: '/', selector: 'section[aria-label="Требует решения"]', title: 'Требует решения',
    text: 'Сюда попадает всё, что ждёт диспетчера: машина на точке без BELADEN/ENTLADEN, пробка на маршруте, отклонение от маршрута, Termin под угрозой. Сейчас список может быть пуст.' },
  { id: 'map', route: '/', selector: 'section[aria-label="Карта выбранного грузовика"]', mobileSelector: '.mobile-tabbar [data-tab="map"]', title: 'Карта',
    text: 'Выбранная машина, её маршрут и позиция по GPS Webfleet. Источник позиции всегда подписан: свежий Webfleet, устаревший Webfleet или расчёт. Внизу — цвета машин, справа — слои и подложка.' },
  { id: 'card', route: '/', selector: '.truck-card', prepare: 'open-card', title: 'Карточка машины',
    text: 'Открывается по щелчку на строке или на машине на карте. Вкладки: Машина, Водитель, Тур, События, Сервис, Поездки. Во вкладке «Тур» — точки, BELADEN/ENTLADEN, «Изменить тур» и сохранённый Auftrag. «Взять себе» закрепляет машину за вами.' },
  { id: 'panel', route: '/', selector: 'section.vehicle-panel', title: 'Нижняя панель',
    text: 'Этап тура, следующая точка, ETA с учётом пробок и часы тахографа. Полоска сверху сворачивает панель, чтобы карте было больше места.' },
  { id: 'bell', route: '/', selector: '.topbar-bell', mobileSelector: '.mobile-tabbar [data-tab="decisions"]', title: 'Уведомления',
    text: 'Срочное требует решения и звучит даже в тихие часы; «Для сведения» приходит без звука. Рабочие часы и звук настраиваются в Настройках.' },
  { id: 'menu', route: '/', selector: '.account-menu', mobileSelector: '.mobile-tabbar [data-tab="more"]', title: 'Меню диспетчера',
    text: 'Тема дня и ночной смены, звук, ИИ-диспетчер, смена пароля и выход. Здесь же «Обучение» и «Справка», если захотите вернуться к этому туру.' },
  { id: 'assistant', route: '/', selector: 'section.dispatcher-window[role="dialog"]', prepare: 'open-assistant', title: 'ИИ-диспетчер',
    text: '«Диалог» отвечает по выбранной машине: Termin, часы, маршрут. «Прикрепить Auftrag» разбирает PDF, фото или Excel: вы проверяете точки и подтверждаете. Ваши правки запоминаются и учат следующий разбор. «evt. Zuladung» — пометка тура, не точка.' },
  { id: 'orders', route: '/orders/new', selector: '.page-header', title: 'Страница Auftrag',
    text: 'Очередь файлов, проверка каждого заказа отдельно и ожидающие Termin. Адреса подсказываются из адресной книги Webfleet и из выученных правил.' },
  { id: 'vehicles', route: '/vehicles', selector: 'form.work-surface', title: 'Машины',
    text: 'Добавить машину, поправить номер или госномер, задать линию и группу для статуса. В блоке «Подключение Webfleet» машина привязывается к объекту Webfleet — без привязки нет GPS.' },
  { id: 'status', route: '/status', selector: '.page-header', title: 'Статус 07:00',
    text: 'Автоматический список по линии Schnellecke на каждое утро: где машина, что везёт, когда выгрузится. Можно поправить строку и выгрузить в Excel.' },
  { id: 'tours', route: '/tours', selector: '.page-header', title: 'Туры',
    text: 'Все туры всех машин. История не меняется: редактируется только будущая часть тура с проверкой версии.' },
  { id: 'settings', route: '/settings', selector: '.page-header', title: 'Настройки',
    text: 'Тема, звук и рабочие часы этого браузера; правила адресов и правила импорта, которым научили программу; учётные записи — у администратора.' },
  { id: 'done', route: '/', selector: null, title: 'Готово',
    text: 'Это все разделы. Повторить тур или открыть его текстом можно в меню диспетчера: «Обучение» и «Справка».' }
]

export const ONBOARDING_EVENT = 'ops:onboarding'
export const ONBOARDING_LOCAL_KEY = 'ops-onboarding-done'
