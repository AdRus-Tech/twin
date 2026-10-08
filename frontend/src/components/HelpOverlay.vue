<script setup>
import { onBeforeUnmount, onMounted } from 'vue'
import Prov from './Prov.vue'
import logo from '../assets/adrus-logo.webp'

const emit = defineEmits(['close'])
const onKey = (e) => e.key === 'Escape' && emit('close')
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="overlay" role="dialog" aria-modal="true" aria-label="Как читать экран" @click.self="emit('close')">
    <div class="card glow box rise">
      <button class="close" aria-label="Закрыть" @click="emit('close')">×</button>
      <h2>Как читать экран</h2>
      <p class="lead">Инструмент для руководителя смены: где случилось отклонение, как оно ударит по соседним участкам и что можно сделать.</p>
      <div class="grid">
        <div class="card"><h3>Смена онлайн</h3><p>Смена идёт, по ходу приходят сбои и предупреждения ML. На каждое событие — прогноз без мер, рекомендация и сколько машин и тенге она сберегает. Срок ремонта можно подвинуть ползунком, свой сбой — ввести кнопкой «＋ Событие».</p></div>
        <div class="card ai"><h3>ML и ИИ</h3><p>ML-модель по датчикам видит отказ за ~1 час. ИИ по кнопке в карточке объясняет ситуацию и предлагает свою меру — модель линии проверяет её числом.</p></div>
        <div class="card"><h3>Аналитика</h3><p>Демонстрационные данные за 01–02.10: план, факт, брак, простои оборудования и цели завода. Красным — то, что вышло за норму.</p></div>
      </div>
      <h3 class="sub">Состояния участков</h3>
      <div class="states">
        <span><span class="state working">работает</span></span>
        <span><span class="state down">остановлен</span> поломка или ремонт</span>
        <span><span class="state blocked">ждёт: некуда отдать</span> следующий накопитель полон</span>
        <span><span class="state starved">ждёт: нет кузовов</span> перед участком пусто</span>
      </div>
      <h3 class="sub">Откуда каждое число</h3>
      <div class="states">
        <span><Prov kind="source" /> из демонстрационного набора данных</span>
        <span><Prov kind="derived" /> посчитано по этим данным</span>
        <span><Prov kind="assumption" /> цена или параметр, который задаёт пользователь</span>
        <span><Prov kind="simulation" /> расчёт модели линии: посекундное проигрывание смены (не ИИ)</span>
        <span><Prov kind="ml" /> оценка ML-модели прогноза отказов</span>
        <span><Prov kind="ai" /> текст ИИ</span>
      </div>
      <p class="made"><img :src="logo" alt="AdRus Technology" /> <span>Разработка: <b>AdRus Technology</b></span></p>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: absolute; inset: 0; z-index: 20; display: grid; place-items: center; background: rgba(4,6,10,.72); }
.box { width: min(1040px, 94vw); padding: 28px; display: grid; gap: 14px; position: relative; }
.close { position: absolute; top: 14px; right: 16px; font-size: 26px; background: none; border: 0; cursor: pointer; color: var(--ink-2); }
h2 { font-size: 22px; letter-spacing: 0; text-transform: none; color: var(--ink); }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.grid .card p { font-size: 13px; color: var(--ink-2); }
.grid .n { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 9px; background: var(--accent); color: var(--accent-ink); font-weight: 700; margin-bottom: 8px; }
.grid .ai .n { background: linear-gradient(135deg, #b894ff, #4cc4ff); }
.sub { font-size: 13px; color: var(--ink-3); text-transform: uppercase; letter-spacing: .12em; margin-top: 4px; }
.states { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 13px; color: var(--ink-2); }
.states > span { display: inline-flex; align-items: center; gap: 8px; }
.made { display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--ink-3); border-top: 1px solid var(--line); padding-top: 12px; }
.made img { height: 26px; width: auto; }
.made b { color: var(--ink); }
</style>
