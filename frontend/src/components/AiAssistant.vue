<script setup>
import { computed } from 'vue'
import Prov from './Prov.vue'
import { askExplain, askPropose, scenario } from '../scenario'
import { fmt } from '../format'

const props = defineProps({ status: Object })

const names = computed(() => Object.fromEntries((scenario.a?.stations ?? []).map((s) => [s.id, s.name])))

// Ключ факта → понятная подпись («A · Сборка · стоит — нет кузовов»).
const METRIC = {
  output_units: 'машин на выходе', blocked_min: 'стоит — некуда отдать, мин', starved_min: 'стоит — нет кузовов, мин',
  down_min: 'остановка, мин', first_blocked_min: 'начало «некуда отдать», мин', first_starved_min: 'начало «нет кузовов», мин',
  max_queue: 'макс. в накопителе', max: 'макс. в накопителе', max_at_min: 'минута максимума', min: 'мин. в накопителе',
  min_at_min: 'минута минимума', final: 'в накопителе в конце', horizon_min: 'длина смены, мин',
  start_min: 'начало остановки, мин', duration_min: 'ремонт, мин', cycle_s: 'секунд на машину',
  capacity: 'мест в накопителе', initial: 'в накопителе в начале',
}
const PREFIX = { a: 'без мер', b: 'с мерой', delta: 'эффект меры' }
function humanKey(key) {
  const parts = key.split('.')
  const metric = METRIC[parts.at(-1)] ?? parts.at(-1)
  const middle = parts.slice(1, -1).filter((p) => p !== 'param' && p !== 'stoppage')
  const where = middle.map((p, i) => {
    if (p === 'buffers') return 'накопитель'
    if (middle[i - 1] === 'buffers') return ['перед окраской', 'перед сборкой'][Number(p)] ?? `${Number(p) + 1}`
    return names.value[p] ?? p
  }).join(' ')
  return [PREFIX[parts[0]], where, metric].filter(Boolean).join(' · ')
}
function fieldLabel(field) {
  if (field === 'stoppage.duration_min') return 'срок ремонта'
  const m = field?.match(/^buffers\.(\d)\.(capacity|initial)$/)
  if (!m) return field
  const where = ['перед окраской', 'перед сборкой'][Number(m[1])]
  return m[2] === 'capacity' ? `мест в накопителе ${where}` : `машин в накопителе ${where} в начале смены`
}

const live = computed(() => props.status?.live && props.status?.ready)
const prop = computed(() => scenario.ai.propose)
const exp = computed(() => scenario.ai.explain)
const proposal = computed(() => prop.value?.result?.proposal)
const busy = computed(() => scenario.ai.busy)

// Шаги цикла «ИИ предложил → сервер проверил → пересчитали».
const steps = computed(() => {
  const p = prop.value
  const thinking = busy.value === 'propose'
  const ok = p?.status === 'ok'
  const run = scenario.ai.proposeRun
  return [
    { t: 'Модель посчитала смену', d: run ? `без мер: ${run.a} машин` : 'расчёт без ИИ', s: thinking || p ? 'done' : 'idle' },
    { t: 'ИИ прочитал факты расчёта', d: p?.facts_count ? `${p.facts_count} чисел, без данных завода` : thinking ? 'думает…' : '', s: thinking ? 'run' : ok ? 'done' : p ? 'fail' : 'idle' },
    { t: `ИИ предложил ${cands.value.length || ''} ${plural(cands.value.length)}`, d: '', s: ok && cands.value.length ? 'done' : p ? 'fail' : 'idle' },
    { t: 'Сервер проверил каждый', d: cands.value.length ? `разрешено ${cands.value.filter((c) => c.accepted).length} из ${cands.value.length}` : '', s: cands.value.some((c) => c.accepted) ? 'done' : p ? 'fail' : 'idle' },
    { t: 'Модель пересчитала, лучшая мера — рекомендация', d: run?.b != null ? `${run.a} → ${run.b} машин за смену` : '', s: run?.b != null ? 'done' : 'idle' },
  ]
})

const cands = computed(() => prop.value?.result?.proposals ?? [])
const plural = (n) => (n === 1 ? 'вариант' : n >= 2 && n <= 4 ? 'варианта' : 'вариантов')
const sec = (ms) => (ms ? `${fmt(ms / 1000, 1)} с` : '')
</script>

<template>
  <div class="ai">
    <section class="panel-section top">
      <div class="who">
        <span class="orb" :class="{ thinking: !!busy }" aria-hidden="true"></span>
        <div>
          <h3 class="grad-ai">ИИ-ассистент смены</h3>
          <p class="lead">Читает результаты расчёта и подсказывает, что попробовать. Цифры считает модель — ИИ их не придумывает, сервер сверяет каждую.</p>
        </div>
      </div>
      <div class="status">
        <span v-if="status && !status.ready" class="chip bad">не подключён: {{ status.error }}</span>
        <span v-else-if="live" class="chip live"><i></i>подключён · {{ status.model }}</span>
        <span v-else-if="status?.provider === 'saved'" class="chip">сохранённые ответы модели (без сети)</span>
        <span v-else class="chip">демо-режим: шаблон без модели</span>
      </div>
    </section>

    <section class="panel-section">
      <button class="action card glow ai-glow" :disabled="!!busy" @click="askPropose">
        <span class="icon-badge ai"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/></svg></span>
        <span class="txt"><b>{{ busy === 'propose' ? 'ИИ думает…' : 'Найди, как снизить потери' }}</b><small>предложит меры, модель проверит и пересчитает каждую</small></span>
      </button>
      <button class="action card" :disabled="!!busy || !scenario.result" @click="askExplain">
        <span class="icon-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg></span>
        <span class="txt"><b>{{ busy === 'explain' ? 'ИИ думает…' : 'Объясни эффект меры' }}</b><small>простыми словами, со ссылками на цифры расчёта</small></span>
      </button>
      <p v-if="scenario.ai.error" class="error" role="alert">Запрос не выполнен: {{ scenario.ai.error }}</p>
    </section>

    <section v-if="prop || busy === 'propose'" class="panel-section">
      <h2>Как ИИ пришёл к рекомендации</h2>
      <ol class="pipeline">
        <li v-for="(s, i) in steps" :key="i" :class="s.s">
          <span class="mark">{{ s.s === 'done' ? '✓' : s.s === 'fail' ? '✕' : s.s === 'run' ? '' : i + 1 }}</span>
          <span><b>{{ s.t }}</b><small v-if="s.d">{{ s.d }}</small></span>
        </li>
      </ol>
      <div v-if="cands.length" class="cands">
        <div v-for="(c, i) in cands" :key="i" class="cand" :class="{ best: c.best, rejected: !c.accepted }">
          <div class="c-top">
            <b>{{ fieldLabel(c.field) }} = {{ c.value }}</b>
            <span v-if="c.best" class="chip good">лучшая → рекомендация</span>
            <span v-else-if="!c.accepted" class="chip bad">отклонён сервером</span>
          </div>
          <small class="why">{{ c.accepted ? c.rationale : c.reason }}</small>
          <div v-if="c.accepted && c.delta_output != null" class="c-res">
            <span :class="c.delta_output > 0 ? 'pos' : c.delta_output < 0 ? 'neg' : ''">{{ c.delta_output > 0 ? '+' : '' }}{{ c.delta_output }} машин</span>
            <span>простой соседей {{ c.delta_idle_min > 0 ? '+' : '' }}{{ fmt(c.delta_idle_min, 0) }} мин</span>
          </div>
        </div>
      </div>
    </section>

    <template v-for="[key, title, ans] in [['propose', 'Вывод ИИ', prop], ['explain', 'Объяснение эффекта', exp]]" :key="key">
      <section v-if="ans" class="panel-section">
        <div class="ans-head">
          <h2>{{ title }}</h2>
          <span v-if="ans.status === 'ok'" class="meta">
            <Prov :kind="ans.source === 'live' ? 'ai' : ans.source" />
            {{ ans.source === 'live' ? ans.model : ans.source === 'saved' ? `${ans.model}, сохранён` : 'шаблон' }}
            <template v-if="scenario.ai.ms[key]"> · {{ sec(scenario.ai.ms[key]) }}</template>
          </span>
        </div>
        <div v-if="ans.status !== 'ok'" class="fail-box">
          <p><span class="state down">ИИ недоступен</span> {{ ans.error }}</p>
          <p class="muted small">Расчёт и сравнение не зависят от ИИ и остаются верными.</p>
          <button class="btn" @click="key === 'propose' ? askPropose() : askExplain()">Повторить</button>
        </div>
        <template v-else>
          <div class="bubble main">{{ ans.result.summary }}</div>
          <div v-for="(f, i) in ans.result.findings" :key="i" class="bubble" :class="{ unverified: !f.verified }">
            <p>{{ f.observation }}</p>
            <p v-if="f.consequence" class="cons">{{ f.consequence }}</p>
            <div class="evidence">
              <span v-for="e in f.evidence" :key="e.key" class="ev" :class="{ bad: !e.verified }" :title="e.key">
                {{ e.verified ? '✓ сверено' : '✕ не совпало' }}: {{ humanKey(e.key) }} = {{ fmt(e.claimed, Number.isInteger(e.claimed) ? 0 : 1) }}
                <template v-if="!e.verified"> (в расчёте {{ e.actual ?? 'нет' }})</template>
              </span>
            </div>
          </div>
          <details v-if="ans.result.limitations.length || ans.result.assumptions.length" class="pro">
            <summary>Ограничения, которые назвал ИИ</summary>
            <ul class="small"><li v-for="x in [...ans.result.assumptions, ...ans.result.limitations]" :key="x">{{ x }}</li></ul>
          </details>
        </template>
      </section>
    </template>

    <section class="panel-section">
      <p class="muted small">Что ИИ не делает: не считает выпуск и простои, не меняет параметры без проверки сервером и не предсказывает поломки оборудования — это делает отдельная ML-модель по датчикам (кнопка «Оборудование»).</p>
    </section>
  </div>
</template>

<style scoped>
.top { gap: 10px; background: radial-gradient(120% 100% at 0% 0%, rgba(184,148,255,.18), transparent 60%); }
.who { display: flex; gap: 14px; align-items: flex-start; }
.who h3 { font-size: 20px; }
.orb {
  width: 46px; height: 46px; border-radius: 50%; flex: none;
  background: conic-gradient(from 0deg, #b894ff, #4cc4ff, #dcff4f, #b894ff);
  box-shadow: 0 0 26px rgba(184,148,255,.6); animation: orb 8s linear infinite;
}
.orb.thinking { animation-duration: 1.2s; box-shadow: 0 0 40px rgba(184,148,255,.9); }
.status .chip.live { color: var(--ok); border-color: rgba(62,232,169,.4); }
.status .chip.live i { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 8px var(--ok); animation: pulse-dot 1.6s infinite; }
.action { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; cursor: pointer; color: var(--ink); transition: transform .2s; }
.action:hover:not(:disabled) { transform: translateY(-2px); }
.action:disabled { opacity: .6; cursor: default; }
.action .txt { display: grid; }
.action b { font-size: 15px; }
.action small { font-size: 12px; color: var(--ink-2); }
.error { color: var(--down); font-size: 13px; }
.pipeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; }
.pipeline li { display: flex; gap: 12px; padding-bottom: 12px; position: relative; color: var(--ink-3); }
.pipeline li:not(:last-child)::after { content: ""; position: absolute; left: 12px; top: 26px; bottom: 0; width: 2px; background: var(--line); }
.pipeline li.done:not(:last-child)::after { background: linear-gradient(var(--ok), rgba(62,232,169,.2)); }
.pipeline .mark { width: 26px; height: 26px; border-radius: 50%; flex: none; display: grid; place-items: center; font-size: 12px; font-weight: 700; border: 1px solid var(--line-strong); }
.pipeline li > span:last-child { display: grid; }
.pipeline b { font-size: 13px; font-weight: 600; }
.pipeline small { font-size: 12px; }
.pipeline li.done { color: var(--ink); }
.pipeline li.done .mark { background: var(--ok); border-color: var(--ok); color: #05140d; }
.pipeline li.done small { color: var(--ink-2); }
.pipeline li.fail .mark { background: var(--down); border-color: var(--down); color: #fff; }
.pipeline li.run .mark { border: 2px solid var(--ai); border-top-color: transparent; animation: orb 0.8s linear infinite; }
.cands { display: grid; gap: 8px; margin-top: 4px; }
.cand { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; display: grid; gap: 4px; background: rgba(255,255,255,.03); }
.cand.best { border-color: rgba(62,232,169,.6); background: linear-gradient(135deg, rgba(62,232,169,.12), rgba(220,255,79,.05)); }
.cand.rejected { opacity: .6; }
.c-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; }
.why { font-size: 12px; color: var(--ink-2); }
.c-res { display: flex; gap: 12px; font-size: 12px; color: var(--ink-2); }
.c-res .pos { color: var(--ok); font-weight: 700; }
.c-res .neg { color: var(--down); font-weight: 700; }
.ans-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.meta { font-size: 11px; color: var(--ink-3); display: inline-flex; align-items: center; gap: 6px; }
.bubble { background: rgba(255,255,255,.05); border: 1px solid var(--line); border-radius: 4px 16px 16px 16px; padding: 10px 12px; display: grid; gap: 6px; font-size: 13.5px; }
.bubble.main { background: linear-gradient(135deg, rgba(184,148,255,.2), rgba(76,196,255,.1)); border-color: rgba(184,148,255,.4); font-size: 14.5px; font-weight: 500; }
.bubble.unverified p:first-child { color: var(--ink-3); }
.cons { color: var(--ink-2); font-size: 12.5px; }
.evidence { display: flex; flex-wrap: wrap; gap: 4px; }
.ev { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: rgba(62,232,169,.1); color: var(--ok); border: 1px solid rgba(62,232,169,.25); }
.ev.bad { background: var(--down-bg); color: var(--down); border-color: rgba(255,77,97,.3); }
.fail-box { display: grid; gap: 6px; justify-items: start; }
.small { font-size: 12px; }
details ul { margin: 6px 0 0; padding-left: 18px; color: var(--ink-2); }
</style>
