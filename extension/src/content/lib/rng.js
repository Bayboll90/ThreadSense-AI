/**
 * Случайные величины для content script.
 *
 * Повторяет src/common/rng.js — модуль оттуда недоступен в классическом
 * content-скрипте. Здесь только то, что реально нужно рукам: задержки набора,
 * траектории курсора, паузы скролла.
 */

(() => {
  const TA = (window.__TA = window.__TA || {});
  if (TA.rng) return;

  function u01() {
    let u = 0;
    while (u === 0) u = Math.random();
    return u;
  }

  const uniform = (a, b) => a + (b - a) * Math.random();
  const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  const chance = (p) => Math.random() < p;
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  function gauss(mu = 0, sigma = 1) {
    return mu + sigma * Math.sqrt(-2 * Math.log(u01())) * Math.cos(2 * Math.PI * u01());
  }

  /** Экспоненциальное со средним mean, обрезанное повторным розыгрышем. */
  function expDelay(mean, min, max) {
    if (!(mean > 0)) return min;
    for (let i = 0; i < 12; i++) {
      const x = -mean * Math.log(u01());
      if (x >= min && x <= max) return x;
    }
    return clamp(-mean * Math.log(u01()), min, max);
  }

  /**
   * Логнормальное. Так распределены интервалы между нажатиями клавиш у людей:
   * плотное ядро на привычных сочетаниях и длинный правый хвост на паузах.
   */
  function lognormal(mean, cv = 0.55) {
    const sigma2 = Math.log(1 + cv * cv);
    const mu = Math.log(mean) - sigma2 / 2;
    return Math.exp(gauss(mu, Math.sqrt(sigma2)));
  }

  function lognormalClamped(mean, cv, min, max) {
    for (let i = 0; i < 12; i++) {
      const x = lognormal(mean, cv);
      if (x >= min && x <= max) return x;
    }
    return clamp(mean, min, max);
  }

  function pick(arr) {
    return arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined;
  }

  TA.rng = { u01, uniform, randInt, chance, clamp, gauss, expDelay, lognormal, lognormalClamped, pick };
})();
