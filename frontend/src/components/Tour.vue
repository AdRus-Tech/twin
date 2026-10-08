<script setup>
// Режим презентации: шаги по главам, каждый сам открывает нужный экран, ведёт смену
// и подсвечивает блок. Клавиши: → / пробел / PageDown — дальше, ← / PageUp — назад,
// F — полный экран, Esc — выход. Работает с кликером.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import { forecastMonth } from '../plan'
import { scenario } from '../scenario'
import { askAi, decide, live, pauseLive, prepareLive, resumeLive, startLive, stopLive } from '../live'
import { fmt } from '../format'

const props = defineProps({
  // Управление экраном из App: раздел, диалоги.
  ctl: { type: Object, required: true },
})
const emit = defineEmits(['close'])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let alive = true
async function until(cond, ms = 90000) {
  const end = Date.now() + ms
  while (alive && !cond()) {
    if (Date.now() > end) throw new Error('не дождались')
    await sleep(100)
  }
}
// Ждём события в смене; если смена идёт — ускоряем до него.
async function untilDecision(kind) {
  const ok = () => live.status === 'decision' && live.pending && (!kind || live.pending.item.kind === kind)
  if (!ok() && live.status === 'running') live.speed = 20
  await until(() => ok() || live.status === 'finished')
  live.speed = 10
}

const ctx = reactive({ month: null })
const cars = (n) => `${fmt(n)}`

const steps = [
  {
    chapter: 'О системе',
    title: 'Цифровой двойник производственной линии',
    text: () => 'Виртуальная копия линии «Сварка → Окраска → Сборка» на демонстрационных данных. Двойник <b>видит</b> событие на линии, <b>считает</b> последствия по цепочке участков, <b>предлагает</b> меру и показывает эффект в машинах, тенге и плане месяца. Решение — за руководителем.',
    enter: async () => {
      props.ctl.mode('live')
      await prepareLive()
    },
  },
  {
    chapter: 'О системе',
    title: 'Цели завода',
    target: '.scene-tools',
    text: () => 'Цели линии — OEE ≥ 85%, брак ≤ 2%, простой ≤ 60 мин в сутки, выпуск ≥ 5 500 в месяц. Статус каждой считается по демонстрационным данным.',
    enter: () => props.ctl.mode('live'),
  },
  {
    chapter: 'О системе',
    title: 'Аналитика по демонстрационным данным',
    target: '.side',
    text: () => 'План и факт по линиям за 01–02.10, брак, журнал простоев оборудования. Главное отклонение вынесено наверх: брак на окраске 5,17% — в 2,6 раза выше нормы. Эти же данные питают модель линии.',
    enter: () => props.ctl.mode('data'),
  },
  {
    chapter: 'Смена онлайн',
    title: 'Модель линии',
    target: '.hero',
    text: () => `Шесть узлов от склада комплектующих до склада готовой продукции, накопители между участками. Модель считает смену по секундам: кто работает, кто ждёт, где растёт очередь. Без происшествий линия даёт <b>${live.base ?? '—'}</b> машины при плане ${live.plan}; узкое место — сборка, 235 с на машину.`,
    enter: async () => {
      props.ctl.mode('live')
      await prepareLive()
    },
  },
  {
    chapter: 'Смена онлайн',
    title: 'Смена пошла',
    target: '.dock',
    once: true,
    text: () => 'Смена 08:00–16:00 идёт в ускоренном времени. События приходят сами: сбои из демонстрационного журнала простоев и предупреждения ML по телеметрии оборудования.',
    enter: async () => {
      props.ctl.mode('live')
      live.autopilot = false
      live.speed = 10
      await startLive()
    },
  },
  {
    chapter: 'Смена онлайн',
    title: 'Сбой: что будет без мер',
    target: '.side div.decision',
    once: true,
    text: () => {
      const p = live.pending
      if (!p) return 'Ждём событие на линии…'
      const head = `${p.name} · ${p.item.equipment}: ${p.item.reason}. Модель сразу считает цепочку: без мер смена даёт <b>${p.outA}</b>, с рекомендацией — <b>${p.outB}</b>.`
      return p.cars > 0
        ? `${head} Эффект — в машинах и тенге, срок ремонта можно двигать ползунком.`
        : `${head} Накопители поглощают этот сбой — смена не теряет машин${p.idle > 0 ? `, а быстрый ремонт сокращает простой соседей на ${p.idle} мин` : ''}.`
    },
    enter: () => untilDecision(),
  },
  {
    chapter: 'Смена онлайн',
    title: 'Совет ИИ',
    target: '.side .ai-box',
    once: true,
    text: () => 'ИИ получает расчёт модели и предлагает свою меру. Сервер проверяет каждое предложение моделью линии — в карточку попадает только проверенный эффект.',
    enter: async () => {
      if (!live.pending) return
      askAi()
      await until(() => !live.pending || (live.pending.ai && !live.pending.ai.busy))
    },
  },
  {
    chapter: 'Смена онлайн',
    title: 'Решение принято',
    target: '.forecast-wrap',
    once: true,
    text: () => 'Решение уходит в расчёт оставшейся смены и в журнал инцидентов. Карточка «Прогноз» показывает, какой участок встанет следующим и когда, — над участком в 3D идёт обратный отсчёт.',
    enter: async () => {
      if (live.pending) await decide('rec')
    },
  },
  {
    chapter: 'Предупреждение ML',
    title: 'Отказ ещё не случился',
    target: '.side div.decision',
    once: true,
    text: () => {
      const p = live.pending
      if (!p) return 'Смена идёт, модель ML следит за оборудованием…'
      return `ML увидела по телеметрии риск отказа <b>${p.item.equipment}</b> заранее. Выбор: заменить узел сейчас или работать до аварии. Без мер — <b>${p.outA}</b> машин, с заменой — <b>${p.outB}</b>.`
    },
    enter: () => untilDecision('ml'),
  },
  {
    chapter: 'Предупреждение ML',
    title: 'Как проверена ML-модель',
    target: '.overlay .box',
    once: true,
    text: () => 'Модель оценивает риск отказа в ближайшие 2 часа по последнему часу телеметрии. На отложенной выборке AUC 0,97, все 13 отказов конвейера пойманы, в среднем за ~65 минут. Риск объясняется понятным языком: «вибрация выше нормы».',
    enter: async () => {
      if (live.pending) await decide('rec')
      pauseLive()
      props.ctl.monitor(true)
    },
  },
  {
    chapter: 'Сообщение с линии',
    title: 'Рабочий пишет как есть',
    target: () => (live.pending ? '.side div.decision' : '.side .msg'),
    once: true,
    text: () => 'Без формы и полей: «на сборке порвалась цепь, минут на 40». ИИ разбирает текст в событие — участок, причина, срок; сервер проверяет каждое поле. Через секунду у руководителя карточка решения с последствиями.',
    enter: async () => {
      props.ctl.monitor(false)
      await nextTick()
      await until(() => document.querySelector('.side .msg textarea'), 5000)
      const ta = document.querySelector('.side .msg textarea')
      ta.scrollIntoView({ block: 'center' })
      const msg = 'на сборке порвалась цепь, минут на 40'
      for (let i = 1; i <= msg.length && alive; i++) {
        ta.value = msg.slice(0, i)
        ta.dispatchEvent(new Event('input'))
        await sleep(35)
      }
      ta.closest('form').requestSubmit()
      await until(() => live.status === 'decision' && live.pending?.item.kind === 'manual')
    },
  },
  {
    chapter: 'Итоги',
    title: 'Итоги смены',
    target: '.side .summary',
    once: true,
    text: () => {
      const s = live.summary
      if (!s) return 'Смена доходит до 16:00…'
      return `Смена закончилась: <b>${s.fact}</b> машин при плане ${s.plan}. Без мер по тем же событиям было бы ${s.noneOut}. Решения двойника сберегли <b>${s.saved}</b> машин за одну смену.`
    },
    enter: async () => {
      if (live.pending) await decide('rec')
      live.autopilot = true
      live.speed = 20
      resumeLive()
      await until(() => live.status === 'finished' && live.summary)
      live.autopilot = false
      live.speed = 10
      await nextTick()
      document.querySelector('.side .summary')?.scrollIntoView({ block: 'nearest' })
    },
  },
  {
    chapter: 'Итоги',
    title: 'План месяца 5 500',
    target: '.side .month .scale',
    text: () => {
      const f = ctx.month
      if (!f) return 'Считаем месяц…'
      return `Проиграно 3 000 месяцев: сбои с частотой из демонстрационного журнала, потери каждого — по модели линии. Без мер — <b>${cars(f.none.mean)}</b>, с решениями двойника — <b>${cars(f.rec.mean)}</b>: +${cars(f.gain)} машин в месяц. Но даже без сбоев линия даёт ${cars(f.capacity)}: для 5 500 нужны +${f.extraShifts} смены или такт сборки ≤ ${f.cycleNeeded} с.`
    },
    enter: async () => {
      if (!ctx.month) ctx.month = forecastMonth(await api.planMonth(), scenario.month.workdays || 22)
      await until(() => document.querySelector('.side .month'), 5000)
      document.querySelector('.side .month')?.scrollIntoView({ block: 'start' })
    },
  },
  {
    chapter: 'Итоги',
    title: 'План по моделям',
    target: '.side .models',
    text: () => {
      const b = ctx.month?.byModel
      if (!b) return ''
      return `Onix, Cobalt и JAC J7 — ${cars(b.total)} машин — закрываются за ${fmt(ctx.month.workdays - b.freeDays, 1)} рабочего дня. Ещё ${cars(b.unassigned)} машин плана в данных не распределены по моделям: двойник показывает это расхождение и сколько из них линия успевает.`
    },
    enter: async () => {
      await until(() => document.querySelector('.side .models'), 5000)
      document.querySelector('.side .models')?.scrollIntoView({ block: 'center' })
    },
  },
  {
    chapter: 'Итоги',
    title: 'Журнал инцидентов',
    target: '.overlay .box',
    text: () => 'Каждое событие и решение смены — запись с приоритетом по последствиям в модели и статусами «новый → в работе → закрыт». На сервере журнал хранится в PostgreSQL.',
    enter: () => props.ctl.incidents(true),
  },
  {
    chapter: 'Итоги',
    title: 'Цифровой двойник от AdRus Technology',
    text: () => 'Событие → модель линии → последствия в машинах и тенге → решение → итог смены и плана месяца. ML предупреждает до отказа, ИИ разбирает сообщения и предлагает меры, каждое число проверено моделью линии.<br><br>Django · PostgreSQL · Vue · three.js · Docker · CI',
    enter: () => props.ctl.incidents(false),
  },
]

const chapters = [...new Set(steps.map((s) => s.chapter))]
const i = ref(0)
const busy = ref(false)
const failed = ref('')
const visited = new Set()
const step = computed(() => steps[i.value])

async function show(n, forward) {
  i.value = n
  failed.value = ''
  const s = steps[n]
  // Шаги, двигающие смену, выполняются один раз; при возврате — только подсказка.
  if (s.once && visited.has(n)) return
  if (!forward && s.once) return
  visited.add(n)
  busy.value = true
  try {
    await s.enter?.()
  } catch (e) {
    failed.value = e.message
  } finally {
    busy.value = false
  }
}
function next() {
  if (busy.value) return
  if (i.value < steps.length - 1) {
    if (i.value !== 9 && i.value !== 14) props.ctl.closeDialogs()
    show(i.value + 1, true)
  } else close()
}
function back() {
  if (busy.value || i.value === 0) return
  props.ctl.closeDialogs()
  show(i.value - 1, false)
}
function close() {
  alive = false
  live.autopilot = false
  props.ctl.closeDialogs()
  emit('close')
}
function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.()
  else document.documentElement.requestFullscreen?.()
}

function onKey(e) {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return
  if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) next()
  else if (['ArrowLeft', 'PageUp'].includes(e.key)) back()
  else if (e.key === 'Escape') close()
  else if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') fullscreen()
  else return
  e.preventDefault()
  e.stopPropagation()
}

// Подсветка и место карточки: следим за целью каждый кадр (панели двигаются и прокручиваются).
const rect = ref(null)
const card = ref(null)
const pos = ref({ left: 24, top: 100 })
let raf = 0
function frame() {
  const t = step.value.target
  const sel = typeof t === 'function' ? t() : t
  const el = sel ? document.querySelector(sel) : null
  const r = el?.getBoundingClientRect()
  rect.value = r && r.width > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null
  const vw = window.innerWidth
  const vh = window.innerHeight
  const cw = card.value?.offsetWidth ?? 420
  const ch = card.value?.offsetHeight ?? 220
  const m = 18
  const clampTop = (y) => Math.max(m, Math.min(vh - ch - m, y))
  const R = rect.value
  if (!R) pos.value = { left: (vw - cw) / 2, top: (vh - ch) / 2 }
  else if (R.left - cw - 2 * m > 0) pos.value = { left: R.left - cw - m, top: clampTop(R.top) }
  else if (R.left + R.width + cw + 2 * m < vw) pos.value = { left: R.left + R.width + m, top: clampTop(R.top) }
  else if (R.top - ch - 2 * m > 0) pos.value = { left: Math.max(m, Math.min(vw - cw - m, R.left)), top: R.top - ch - m }
  else if (R.top + R.height + ch + 2 * m < vh) pos.value = { left: Math.max(m, Math.min(vw - cw - m, R.left)), top: R.top + R.height + m }
  else pos.value = { left: m, top: vh - ch - m }
  raf = requestAnimationFrame(frame)
}

onMounted(() => {
  window.addEventListener('keydown', onKey, true)
  raf = requestAnimationFrame(frame)
  stopLive()
  show(0, true)
})
onBeforeUnmount(() => {
  alive = false
  window.removeEventListener('keydown', onKey, true)
  cancelAnimationFrame(raf)
})
</script>

<template>
  <div class="tour" role="dialog" aria-label="Презентация">
    <div v-if="rect" class="spot" :style="{ left: `${rect.left - 6}px`, top: `${rect.top - 6}px`, width: `${rect.width + 12}px`, height: `${rect.height + 12}px` }"></div>
    <div v-else class="dim"></div>
    <div ref="card" class="tcard" :style="{ left: `${pos.left}px`, top: `${pos.top}px` }">
      <div class="chap">
        <span>{{ step.chapter }}</span>
        <span class="n">{{ i + 1 }} / {{ steps.length }}</span>
      </div>
      <div class="bars" aria-hidden="true">
        <i v-for="c in chapters" :key="c" :class="{ on: c === step.chapter, done: chapters.indexOf(c) < chapters.indexOf(step.chapter) }"></i>
      </div>
      <h2>{{ step.title }}</h2>
      <p class="txt" v-html="step.text()"></p>
      <p v-if="busy" class="wait"><span class="dot" aria-hidden="true"></span> двойник считает…</p>
      <p v-if="failed" class="err">Шаг не выполнился: {{ failed }}</p>
      <div class="nav">
        <button class="btn" :disabled="i === 0 || busy" @click="back">←</button>
        <button class="btn primary" :disabled="busy" @click="next">{{ i === steps.length - 1 ? 'Завершить' : 'Далее →' }}</button>
        <span class="keys">→ дальше · F экран · Esc выход</span>
        <button class="x" aria-label="Выйти из презентации" @click="close">×</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tour { position: fixed; inset: 0; z-index: 90; pointer-events: none; }
.dim { position: absolute; inset: 0; background: rgba(4, 6, 10, .55); }
.spot {
  position: absolute; border-radius: 16px; border: 2px solid var(--accent);
  box-shadow: 0 0 0 9999px rgba(4, 6, 10, .55), 0 0 30px rgba(220, 255, 79, .35);
  transition: left .35s ease, top .35s ease, width .35s ease, height .35s ease;
}
.tcard {
  position: absolute; width: 420px; max-width: calc(100vw - 36px); pointer-events: auto;
  display: grid; gap: 8px; padding: 16px 18px 14px; border-radius: 18px;
  background: rgba(13, 17, 23, .97); border: 1px solid rgba(220, 255, 79, .45);
  box-shadow: 0 20px 60px rgba(0, 0, 0, .6); transition: left .35s ease, top .35s ease;
}
.chap { display: flex; justify-content: space-between; font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--accent); }
.chap .n { color: var(--ink-3); letter-spacing: .04em; }
.bars { display: flex; gap: 4px; }
.bars i { flex: 1; height: 3px; border-radius: 2px; background: rgba(255, 255, 255, .1); }
.bars i.done { background: rgba(220, 255, 79, .45); }
.bars i.on { background: var(--accent); }
h2 { font-size: 19px; line-height: 1.2; }
.txt { font-size: 14px; line-height: 1.5; color: var(--ink-2); }
.txt :deep(b) { color: var(--ink); }
.wait { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ai); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ai); animation: pulse-dot 1s infinite; }
.err { font-size: 12.5px; color: var(--down); }
.nav { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.nav .btn { padding: 7px 14px; }
.keys { font-size: 11px; color: var(--ink-3); margin-left: auto; }
.x { width: 26px; height: 26px; border-radius: 8px; border: 1px solid var(--line-strong); background: rgba(255, 255, 255, .06); color: var(--ink-2); cursor: pointer; font-size: 16px; line-height: 1; }
.x:hover { background: var(--accent); color: var(--accent-ink); }
</style>
