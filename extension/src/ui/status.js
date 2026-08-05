/**
 * Окно состояния агента.
 *
 * Заменяет плашку, которая до 04.08.2026 висела прямо на странице Threads.
 * Плашку убрали не потому, что она мешала, а потому, что она лежала в DOM
 * сайта: узел с текстом «ThreadSense AI» и правило `.__ta-overlay` в общей
 * таблице стилей читаются со страницы одной строкой. Агент носил бирку.
 *
 * Отказаться от показа совсем было нельзя. На боевом сервере без
 * подключённого рабочего стола единственный способ понять, чем занят агент, —
 * снимок окна через `PrintWindow`, и не раз именно плашка давала диагноз
 * быстрее журнала: «ждём · остановка: undefined · дальше через 5 мин» вывело
 * на опечатку в перечне, о которой в журнале не было ни строки.
 *
 * Поэтому состояние переехало в отдельное окно расширения: сайту оно
 * недоступно, а в снимок экрана попадает.
 */

import { MSG, HALT_LABEL, send } from '../common/messages.js';

const $ = (id) => document.getElementById(id);

/** Что показывать вместо кода команды. */
const CMD_LABEL = {
  [MSG.CMD_IDLE]: 'ждём',
  [MSG.CMD_SCAN]: 'смотрим ленту',
  [MSG.CMD_GOTO]: 'переход',
  [MSG.CMD_BROWSE]: 'читаем',
  [MSG.CMD_OPEN_THREAD]: 'открываем ветку',
  [MSG.CMD_REPLY]: 'пишем ответ',
  [MSG.CMD_POST]: 'публикуем пост',
  [MSG.CMD_RECHECK]: 'перепроверяем',
  [MSG.CMD_LIKE]: 'ставим лайк',
  [MSG.CMD_COLLECT_STYLE]: 'собираем стиль',
  [MSG.CMD_RELOAD]: 'перезагружаем страницу',
};

function countdown(at) {
  if (!at || at <= Date.now()) return '';
  const sec = Math.round((at - Date.now()) / 1000);
  if (sec > 5400) return `дальше через ${Math.round(sec / 3600)} ч`;
  if (sec > 90) return `дальше через ${Math.round(sec / 60)} мин`;
  return `дальше через ${sec} с`;
}

function paint(s) {
  if (!s?.ok) {
    $('status').textContent = 'нет связи с агентом';
    $('why').textContent = 'фон не отвечает';
    $('dot').className = 'dot stop';
    return;
  }

  $('handle').textContent = s.handle ? `@${s.handle}` : 'ThreadSense AI';

  const cmd = s.lastCommand;
  const live = s.enabled && !s.halt && s.breaker !== 'open';

  $('dot').className = `dot${s.halt ? ' stop' : (live ? '' : ' off')}`;

  if (!s.enabled) {
    $('status').textContent = 'выключен';
    $('why').textContent = 'включается в настройках расширения';
    $('next').textContent = '';
  } else {
    $('status').textContent = CMD_LABEL[cmd?.cmd] || (cmd ? cmd.cmd : 'ожидание');
    $('why').textContent = cmd?.why || '';
    $('next').textContent = countdown(cmd?.next || s.nextActionAt);
  }

  /*
   * Счётчики дня. Их на плашке не было, а спрашивали о них чаще всего —
   * «сколько уже написал сегодня» решается взглядом на снимок.
   */
  $('counters').innerHTML = [
    `коммент. <b>${s.dayCount || 0}</b> из ${s.dayLimit || 0}`,
    `посты <b>${s.dayPosts || 0}</b>${s.postLimit ? ` из ${s.postLimit}` : ''}`,
    `лайки <b>${s.dayLikes || 0}</b>`,
  ].join(' · ');

  const halt = $('halt');
  if (s.halt) {
    halt.hidden = false;
    const label = HALT_LABEL[s.halt.reason] || s.halt.reason || 'остановка без причины';
    const until = s.halt.until ? ` · до ${new Date(s.halt.until).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : ' · без срока';
    halt.textContent = `${label}${until}`;
  } else {
    halt.hidden = true;
  }
}

async function refresh() {
  paint(await send({ type: MSG.UI_GET_STATUS }));
}

/*
 * Раз в секунду: обратный отсчёт должен идти живой. Это и есть способ
 * отличить «агент ждёт» от «агент завис» по двум снимкам с интервалом —
 * если «дальше через 5 мин» не меняется восемь минут подряд, стоит не
 * ожидание, а тикер.
 */
refresh();
setInterval(refresh, 1000);
