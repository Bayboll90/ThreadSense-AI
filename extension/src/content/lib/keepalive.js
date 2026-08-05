/**
 * Защита от троттлинга таймеров.
 *
 * Chrome агрессивно душит фоновые вкладки: setTimeout в них может растянуться
 * с 200 миллисекунд до минуты. Для нас это не мелочь, а поломка главного
 * механизма — вся правдоподобность набора держится на точности межсимвольных
 * интервалов. Растянутый вчетверо ввод выглядит не человечнее, а страннее:
 * человек не печатает одно слово полторы минуты.
 *
 * Два независимых приёма.
 *
 * Первый — паузы через MessageChannel. Порт сообщений не считается таймером и
 * под троттлинг не попадает: сообщение доставляется на следующем тике цикла
 * событий. Для коротких пауз это точнее setTimeout на порядок.
 *
 * Второй — неслышимый звук. Вкладка, которая что-то воспроизводит, считается
 * активной, и Chrome её не душит. Осциллятор на 220 герцах с громкостью
 * 0.0008 не слышен ни на каком оборудовании, а вкладку удерживает.
 *
 * Оба приёма — про сохранение точности собственных пауз, а не про работу без
 * ведома пользователя: агент по-прежнему действует только в открытой вкладке.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.keepalive) return;
  const { log, warn } = TA.util;

  /* --------------------------- MessageChannel ----------------------------- */

  /**
   * Пауза, устойчивая к троттлингу.
   *
   * Цепочка сообщений не спит, а крутится по циклу событий, поэтому фоновая
   * вкладка её не растягивает. Но у приёма есть цена, которую я поначалу
   * недооценил: он занимает основной поток целиком на всю длительность паузы.
   *
   * Живой прогон показал, во что это обходится. Набор комментария растянулся
   * на девять минут, к концу — по три-семь секунд на символ. Причина ровно
   * здесь: спин отнимал процессор у самой страницы, а каждый вставленный
   * символ тянет за собой работу Lexical и React. Чем длиннее текст, тем
   * дороже символ, и защита от троттлинга душила набор надёжнее троттлинга.
   *
   * Поэтому спин включается только там, где таймеру верить действительно
   * нельзя: вкладка скрыта и звуковой удерживатель не работает. Видимая
   * вкладка таймеры не душит вовсе, а вкладка со звуком выведена из-под
   * троттлинга самим Chrome — в обоих случаях обычный таймер и точнее, и
   * дешевле.
   */
  const PRECISE_UPTO_MS = 4000;

  function preciseSleep(ms) {
    if (!(ms > 0)) return Promise.resolve();

    const risky = document.visibilityState !== 'visible' && !audioActive();
    if (!risky || ms > PRECISE_UPTO_MS) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    const target = performance.now() + ms;
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        if (performance.now() >= target) {
          ch.port1.close();
          ch.port2.close();
          resolve();
        } else {
          ch.port2.postMessage(0);
        }
      };
      ch.port2.postMessage(0);
    });
  }

  /**
   * Прерываемая пауза: возвращает false, если во время ожидания подали сигнал
   * остановки. Нужна, чтобы длинная пауза не мешала выключить агента.
   */
  function interruptibleSleep(ms, shouldStop) {
    const step = Math.min(ms, 500);
    const deadline = performance.now() + ms;

    return (async () => {
      while (performance.now() < deadline) {
        if (shouldStop && shouldStop()) return false;
        await preciseSleep(Math.min(step, deadline - performance.now()));
      }
      return true;
    })();
  }

  /* ------------------------------ Аудио ---------------------------------- */

  let audioCtx = null;
  let osc = null;
  let gestureHooked = false;

  function startAudio() {
    if (osc) return true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;

      audioCtx = audioCtx || new Ctx();
      const gain = audioCtx.createGain();
      gain.gain.value = 0.0008;     // на два порядка ниже порога слышимости

      osc = audioCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 220;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();

      if (audioCtx.state === 'suspended') {
        // Автовоспроизведение заблокировано до первого жеста пользователя.
        // Ждём его: молча оставаться без защиты хуже, чем подождать клика.
        hookGesture();
        return false;
      }
      log('аудио-keepalive запущен');
      return true;
    } catch (e) {
      warn('аудио-keepalive недоступен:', e.message);
      return false;
    }
  }

  function hookGesture() {
    if (gestureHooked) return;
    gestureHooked = true;

    const resume = async () => {
      try {
        await audioCtx?.resume();
        if (audioCtx?.state === 'running') {
          log('аудио-keepalive возобновлён после жеста пользователя');
          off();
        }
      } catch { /* попробуем на следующем жесте */ }
    };
    const off = () => {
      document.removeEventListener('pointerdown', resume, true);
      document.removeEventListener('keydown', resume, true);
      gestureHooked = false;
    };

    document.addEventListener('pointerdown', resume, true);
    document.addEventListener('keydown', resume, true);
  }

  function stopAudio() {
    try {
      osc?.stop();
      osc?.disconnect();
    } catch { /* уже остановлен */ }
    osc = null;
  }

  const audioActive = () => !!osc && audioCtx?.state === 'running';

  /* ------------------------------ Управление ------------------------------ */

  let on = false;

  function start() {
    if (on) return;
    on = true;
    startAudio();
  }

  function stop() {
    if (!on) return;
    on = false;
    stopAudio();
  }

  /** Диагностика для инспектора и статуса. */
  function state() {
    return {
      enabled: on,
      audio: audioActive(),
      audioState: audioCtx?.state || 'none',
      waitingForGesture: gestureHooked,
    };
  }

  TA.keepalive = { start, stop, state, preciseSleep, interruptibleSleep, audioActive };
})();
