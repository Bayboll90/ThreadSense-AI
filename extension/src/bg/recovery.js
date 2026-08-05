/**
 * Каскад восстановления после технических сбоев.
 *
 * Сбой при публикации почти никогда не означает, что дальше работать нельзя.
 * Threads мог перерисовать ленту, форма могла открыться не с той стороны,
 * страница могла зависнуть на полпути. Останавливать сессию на первой же
 * неудаче — значит терять день работы из-за секундной проблемы.
 *
 * Но и делать вид, что ничего не случилось, нельзя: если сбои идут подряд,
 * дело не в конкретном посте, а в странице или в самих селекторах, и упорное
 * продолжение только копит флаги на аккаунте.
 *
 * Отсюда лестница. Каждая ступень дороже предыдущей и применяется, только
 * когда дешёвая не помогла. Успешное действие сбрасывает счётчик: это значит,
 * что проблема была разовой.
 *
 *   1. Пропустить пост и взять следующий      — сбой был в этом посте
 *   2. Вернуться в ленту                      — сбой был на этой странице
 *   3. Перезагрузить страницу                 — сбой был в состоянии вкладки
 *   4. Остановиться                           — сбой системный, нужен человек
 */

import { MSG } from '../common/messages.js';
import { TECHNICAL_SKIPS } from '../common/skipcodes.js';

export const STEP = {
  SKIP_POST: 1,
  BACK_TO_FEED: 2,
  RELOAD_PAGE: 3,
  STOP: 4,
};

export const STEP_LABEL = {
  [STEP.SKIP_POST]: 'пропускаем пост',
  [STEP.BACK_TO_FEED]: 'возвращаемся в ленту',
  [STEP.RELOAD_PAGE]: 'перезагружаем страницу',
  [STEP.STOP]: 'останавливаемся',
};

/**
 * Учесть технический сбой и решить, что делать.
 *
 * @param {object} state    состояние агента (мутируется)
 * @param {object} settings
 * @param {string} code     код пропуска
 * @returns {{step: number, label: string, streak: number}}
 */
export function onTechnicalFailure(state, settings, code) {
  const isTechnical = TECHNICAL_SKIPS.has(code);

  // Нетехнический сбой — проблема поста, а не страницы. Полосу не копим.
  if (!isTechnical) {
    return { step: STEP.SKIP_POST, label: STEP_LABEL[STEP.SKIP_POST], streak: state.technicalStreak || 0 };
  }

  state.technicalStreak = (state.technicalStreak || 0) + 1;
  const limit = settings.safety.technicalStreakLimit || 3;

  if (state.technicalStreak < limit) {
    return { step: STEP.SKIP_POST, label: STEP_LABEL[STEP.SKIP_POST], streak: state.technicalStreak };
  }

  // Полоса набрана — поднимаемся на следующую ступень лестницы.
  //
  // Первая ступень каскада — возврат в ленту: пропуск поста уже испробован
  // всей полосой, что и привела нас сюда. Без этого сдвига первые две серии
  // сбоев обе заканчивались бы возвратом в ленту, и одна ступень пропадала
  // впустую вместе с временем, которое она стоила.
  state.recoveryStep = Math.min(
    Math.max((state.recoveryStep || 0) + 1, STEP.BACK_TO_FEED),
    STEP.STOP,
  );
  state.technicalStreak = 0;

  return { step: state.recoveryStep, label: STEP_LABEL[state.recoveryStep], streak: 0 };
}

/**
 * Успех: проблема была разовой, лестницу можно сложить.
 * Без этого сброса единичные сбои за день накапливаются и однажды
 * останавливают исправно работающего агента.
 */
export function onSuccessfulAction(state) {
  state.technicalStreak = 0;
  state.recoveryStep = 0;
  return state;
}

/**
 * Превратить ступень в команду для content script.
 * @returns {object|null} null означает «просто взять следующий пост»
 */
export function commandFor(step, { homeUrl = 'https://www.threads.com/' } = {}) {
  switch (step) {
    case STEP.BACK_TO_FEED:
      return { cmd: MSG.CMD_GOTO, url: homeUrl, why: 'восстановление: возвращаемся в ленту' };

    case STEP.RELOAD_PAGE:
      return { cmd: MSG.CMD_RELOAD, why: 'восстановление: перезагружаем страницу' };

    case STEP.STOP:
      return null;   // остановку ставит вызывающий: у неё своя причина и срок

    default:
      return null;
  }
}

/** Описание текущего положения на лестнице — для журнала и статуса. */
export function recoveryInfo(state) {
  const step = state.recoveryStep || 0;
  return {
    step,
    label: step ? STEP_LABEL[step] : 'норма',
    streak: state.technicalStreak || 0,
  };
}
