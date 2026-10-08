<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { api } from './api'
import { VARIANT, askPropose, measure, currentFrame, forecast, loadIncidents, loadMl, loadPreset, mlNow, openIncident, runBoth, scenario, wall } from './scenario'
import { fmt, fmtDate, plural, signed } from './format'
import SceneView from './components/SceneView.vue'
import DataPanel from './components/DataPanel.vue'
import DataDock from './components/DataDock.vue'
import ScenarioPanel from './components/ScenarioPanel.vue'
import AiAssistant from './components/AiAssistant.vue'
import Timeline from './components/Timeline.vue'
import HelpOverlay from './components/HelpOverlay.vue'
import ForecastCard from './components/ForecastCard.vue'
import GoalsCard from './components/GoalsCard.vue'
import EventForm from './components/EventForm.vue'
import IncidentsDialog from './components/IncidentsDialog.vue'
import MonitorDialog from './components/MonitorDialog.vue'
import LivePanel from './components/LivePanel.vue'
import Splash from './components/Splash.vue'
import Tour from './components/Tour.vue'
import adrusLogo from './assets/adrus-logo.webp'
import adrusMark from './assets/adrus-mark.webp'
import LiveDock from './components/LiveDock.vue'
import { canAddEvent, live, pauseLive, prepareLive, resumeLive, startLive, stopLive } from './live'

const mode = ref('live') // 'live' | 'data' | 'scenario' | 'ai'
const overview = ref(null)
const history = ref([])
const selected = ref(null)
const aiStatus = ref(null)
const loadError = ref(null)
let loadMlReady = Promise.resolve()
const prefer2d = ref(false)
const showHelp = ref(false)
// Заставка приложения при открытии; #nosplash — без неё (для записи и скриншотов).
const showSplash = ref(!new URLSearchParams(location.hash.slice(1)).has('nosplash'))
const showEvent = ref(false)
const showIncidents = ref(false)
const showMonitor = ref(false)
// Режим презентации: кнопка в шапке или ссылка #tour.
const showTour = ref(false)
const tourCtl = {
  mode: (m) => { mode.value = m },
  monitor: (v) => { showMonitor.value = v },
  incidents: (v) => { showIncidents.value = v },
  closeDialogs: () => {
    showMonitor.value = false
    showIncidents.value = false
    showHelp.value = false
    showEvent.value = false
  },
}
function startTour() {
  showSplash.value = false
  selected.value = null
  heroCollapsed.value = false
  showTour.value = true
}
const heroCollapsed = ref(false)
// Высота подложки с выводом — сцена центрируется ниже неё.
const heroH = computed(() => (heroCollapsed.value ? 52 : 74))
const reducedMotion = ref(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)


async function loadDate(date) {
  overview.value = await api.overview(date)
}

onMounted(async () => {
  try {
    const first = await api.overview()
    history.value = await Promise.all(first.dates.map((d) => api.overview(d)))
    overview.value = first
    scenario.month.target = first.targets.monthly_output_min.value
    scenario.month.shiftsPerDay = first.targets.shifts_per_day.value
    live.plan = first.chain.find((n) => n.id === 'assembly')?.line?.plan.value ?? live.plan
    await loadPreset()
    await loadIncidents()
    loadMlReady = loadMl()
    aiStatus.value = await api.aiStatus()
    // Прямые ссылки для демонстрации: #scenario, #ai, &t=150, &focus=painting, &still
    const hash = new URLSearchParams(location.hash.slice(1))
    if (hash.has('still')) reducedMotion.value = true
    if (hash.has('focus')) selected.value = hash.get('focus')
    if (hash.has('data')) mode.value = 'data'
    if (mode.value === 'live' && !hash.has('scenario') && !hash.has('ai')) {
      await loadMlReady
      await prepareLive()
      if (hash.has('tour')) startTour()
      else if (hash.has('auto')) {
        live.autopilot = true
        if (hash.has('speed')) live.speed = Number(hash.get('speed')) || live.speed
        startLive()
      }
    }
    if (hash.has('scenario') || hash.has('ai')) {
      mode.value = hash.has('ai') ? 'ai' : 'scenario'
      await runBoth()
      if (hash.has('t')) scenario.minute = Number(hash.get('t')) || 0
      if (hash.has('ask')) askPropose()
    }
  } catch (e) {
    loadError.value = `Не удалось загрузить данные с сервера: ${e.message}`
  }
})

const sim = computed(() => mode.value !== 'data')

// Узлы для схемы в режиме данных: отклонение + короткая подпись.
const dataNodes = computed(() => {
  if (!overview.value) return []
  const limit = overview.value.targets.defect_limit_pct.value
  return overview.value.chain.map((n) => {
    const sev = n.flags?.some((f) => f.severity === 'critical') ? 'critical'
      : n.flags?.some((f) => f.severity === 'warning') ? 'warning' : null
    let caption = ''
    if (n.quality && n.quality.defect_pct.value > limit) caption = `брак ${fmt(n.quality.defect_pct.value, 2)}%`
    else if (n.line) caption = `план ${fmt(n.line.plan_completion_pct.value, 1)}%`
    return { id: n.id, name: n.name, hasData: n.has_data, severity: sev, caption }
  })
})

// Главный вывод режима данных — наибольший брак за дату.
const worstDefect = computed(() => {
  const nodes = overview.value?.chain.filter((n) => n.quality) ?? []
  if (!nodes.length) return null
  const limit = overview.value.targets.defect_limit_pct.value
  const worst = nodes.reduce((a, b) => (b.quality.defect_pct.value > a.quality.defect_pct.value ? b : a))
  return { node: worst, value: worst.quality.defect_pct.value, limit, times: worst.quality.defect_pct.value / limit }
})

const simStations = computed(() => scenario.result?.[scenario.view].params.stations ?? scenario.a?.stations ?? null)
const simBuffers = computed(() => scenario.result?.[scenario.view].params.buffers ?? null)
const cmp = computed(() => scenario.result?.comparison)
const stopName = computed(() => {
  const st = scenario.result?.a.params.stoppage
  return st ? scenario.result.a.params.stations.find((s) => s.id === st.station)?.name.toLowerCase() : ''
})
const durA = computed(() => scenario.result?.a.params.stoppage?.duration_min ?? 0)
// Подпись баннера живой смены.
const liveHead = computed(() => {
  const p = live.pending
  const s = live.summary
  if (live.status === 'idle') return { title: 'Смена онлайн — нажмите «Начать смену»', sub: `План ${live.plan} машин (демонстрационные данные) · линия без происшествий даёт ${live.base ?? '—'}` }
  if (p) return { title: `⚠ ${p.name}${p.item.equipment !== '—' ? ` · ${p.item.equipment}` : ''}: ${p.item.reason} — нужно решение`, sub: `Без мер: ${p.outA} машин за смену · с рекомендацией: ${p.outB}` }
  if (s) return { title: `Смена закончена: ${s.fact} машин${s.comparisonAvailable ? `, эффект решений ${s.saved}` : ''}`, sub: `План ${s.plan}${s.comparisonAvailable ? ` · без мер было бы ${s.noneOut}` : ' · эффект решений не рассчитан'}` }
  return { title: `Смена идёт · ${wall(live.t)}`, sub: `План ${live.plan} машин · событий за смену: ${live.decisions.length}` }
})
const stopNameCap = computed(() => (stopName.value ? stopName.value[0].toUpperCase() + stopName.value.slice(1) : ''))
const stopStart = computed(() => scenario.result?.a.params.stoppage?.start_min ?? 0)

// Причины из журнала простоев — подсказки для формы события.
const reasons = computed(() => [...new Set(history.value.flatMap((ov) => ov.chain.flatMap((n) => (n.downtimes ?? []).map((d) => d.reason))))])

// Журнал простоев за все даты и оборудование из него.
const downtimes = computed(() => history.value.flatMap((ov) => ov.chain.flatMap((n) => (n.downtimes ?? []).map((d) => ({ ...d, date: ov.date })))))
const equipment = computed(() => [...new Map(downtimes.value.map((d) => [d.equipment, { name: d.equipment, section: d.section }])).values()])
const openIncidents = computed(() => scenario.incidents.filter((i) => i.status !== 'closed').length)

async function onOpenIncident(inc) {
  showIncidents.value = false
  selected.value = null
  if (mode.value === 'data') mode.value = 'scenario'
  await openIncident(inc)
}

function onNewFromIncidents() {
  showIncidents.value = false
  openEvent()
}

function onMonitorDone() {
  showMonitor.value = false
  selected.value = null
  if (mode.value === 'data' || mode.value === 'live') mode.value = 'scenario'
}

// Событие руководитель вводит прямо в идущую смену: на время ввода смена на паузе.
const canInject = canAddEvent
let resumeAfterEvent = false
function openEvent() {
  if (!canInject.value) return
  if (mode.value !== 'live') mode.value = 'live'
  resumeAfterEvent = live.status === 'running'
  pauseLive()
  showEvent.value = true
}
// Сообщение с линии разобрано не полностью — открываем форму с тем, что поняли.
const eventInitial = ref(null)
function onNeedForm(parsed) {
  eventInitial.value = parsed
  openEvent()
}
function closeEvent() {
  showEvent.value = false
  eventInitial.value = null
  if (resumeAfterEvent) resumeLive()
}

// Подтверждение после ввода события: что посчитано и куда записано.
const notice = ref(null)
let noticeTimer = null
function onEventDone() {
  showEvent.value = false
  eventInitial.value = null
  // В смене событие сразу становится карточкой решения справа.
  if (mode.value === 'live') return
  selected.value = null
  heroCollapsed.value = false
  if (mode.value === 'data') mode.value = 'scenario'
  const e = scenario.event
  const inc = scenario.incidents[0]
  const lost = scenario.baseline ? scenario.baseline.output_units - scenario.result.a.output_units : null
  notice.value = {
    what: `${e.name} встал в ${wall(e.start)}, ремонт ${e.duration} мин`,
    effect: lost === null ? `итог смены ${scenario.result.a.output_units} машин` : lost > 0 ? `смена теряет ${lost} ${plural(lost, 'машину', 'машины', 'машин')}` : 'смена укладывается без потерь',
    inc: inc?.id ?? null,
  }
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (notice.value = null), 9000)
}

function onSelect(id) {
  selected.value = id
}

function go(id) {
  mode.value = id
}

watch(mode, (now, before) => {
  scenario.playing = false
  // Аналитика открывается поверх смены: смена ставится на паузу и не сбрасывается.
  if (before === 'live') (now === 'data' ? pauseLive() : stopLive())
  if (now === 'live') prepareLive()
  if (sim.value && !['welding', 'painting', 'assembly'].includes(selected.value)) selected.value = null
  // Первый вход в модель сразу показывает расчёт синтетического примера.
  if (sim.value && now !== 'live' && scenario.a && !scenario.result && !scenario.running) runBoth()
})
</script>

<template>
  <div class="app" :class="[mode, { still: reducedMotion, focused: !!selected }]">
    <div class="stage">
      <SceneView
        :mode="sim ? 'scenario' : 'data'"
        :data-nodes="dataNodes"
        :frame="sim ? currentFrame : null"
        :stations="sim ? simStations : null"
        :buffers="sim ? simBuffers : null"
        :eta="sim ? forecast?.byStation : null"
        :selected="selected"
        :prefer2d="prefer2d"
        :reduced-motion="reducedMotion"
        :top-extra="heroH"
        @select="onSelect"
      />
    </div>

    <header class="topbar glass rise">
      <div class="brand">
        <svg class="mark" viewBox="0 0 56 24" role="img" aria-label="Модель линии">
          <path d="M8 12H48" stroke="currentColor" stroke-width="2" />
          <rect x="2" y="5" width="12" height="14" rx="3" fill="#dcff4f" />
          <rect x="22" y="5" width="12" height="14" rx="3" fill="#4cc4ff" />
          <rect x="42" y="5" width="12" height="14" rx="3" fill="#3ee8a9" />
        </svg>
        <div class="title">
          <h1>Цифровой двойник автомобильного завода</h1>
        </div>
        <div class="dev" title="Разработка: AdRus Technology">
          <small>разработка</small>
          <img :src="adrusLogo" alt="AdRus Technology" />
        </div>
      </div>

      <nav class="steps" aria-label="Разделы">
        <button class="step live" :class="{ on: mode === 'live' }" :aria-pressed="mode === 'live'" title="Линия сейчас: события, прогноз, рекомендации" @click="go('live')">
          <span class="live-dot" :class="{ run: live.status === 'running' }" aria-hidden="true"></span>
          <span class="t"><b>Смена онлайн</b><small>линия сейчас</small></span>
        </button>
        <button class="step" :class="{ on: mode === 'data' }" :aria-pressed="mode === 'data'" title="Демонстрационные данные за 01–02.10: план, факт, брак, простои" @click="go('data')">
          <span class="t"><b>Аналитика</b><small>данные за 01–02.10</small></span>
        </button>
      </nav>

      <div class="toggles">
        <button class="btn tour-btn" title="Пошаговая презентация: сама открывает экраны и ведёт смену" @click="startTour">▶ Презентация</button>
        <button class="btn event-btn" :disabled="!canInject" :title="canInject ? 'Участок встал — добавить событие в смену' : 'Сначала начните смену'" @click="openEvent">＋ Событие</button>
        <button class="btn inc-btn ml-btn" title="Риск отказа оборудования (ML)" @click="showMonitor = true">Оборудование <span class="ml-tag">ML</span><span v-if="mlNow?.alerts.length" class="badge warn">{{ mlNow.alerts.length }}</span></button>
        <button class="btn inc-btn" title="Журнал инцидентов смены" @click="showIncidents = true">Инциденты<span v-if="openIncidents" class="badge">{{ openIncidents }}</span></button>
        <button class="icon-btn" title="Как читать экран" @click="showHelp = true">?</button>
        <label class="chip" title="Плоская схема вместо 3D"><input v-model="prefer2d" type="checkbox" /> 2D</label>
        <label class="chip" title="Отключить движение"><input v-model="reducedMotion" type="checkbox" /> Без анимации</label>
      </div>
    </header>

    <p v-if="loadError" class="load-error glass" role="alert">{{ loadError }}</p>

    <!-- Главный вывод экрана на подложке -->
    <section v-if="mode === 'data' && worstDefect" :key="'h-data-' + overview.date" class="hero card glow bad-glow rise" :class="{ mini: heroCollapsed }">
      <span class="big hero-num down">{{ fmt(worstDefect.value, 2) }}<small>%</small></span>
      <div v-if="!heroCollapsed" class="hero-cap">
        <b>брака на «{{ worstDefect.node.name }}» — в {{ fmt(worstDefect.times, 1) }} раза выше нормы {{ worstDefect.limit }}%</b>
        <span>{{ worstDefect.node.quality.defects.value }} из {{ worstDefect.node.quality.released.value }} · {{ fmtDate(overview.date) }} · демонстрационные данные</span>
      </div>
      <span v-else class="mini-cap">брак «{{ worstDefect.node.name }}»</span>
      <button class="fold" :title="heroCollapsed ? 'Развернуть' : 'Свернуть, чтобы видеть 3D'" @click="heroCollapsed = !heroCollapsed">{{ heroCollapsed ? '⤢' : '–' }}</button>
    </section>

    <section v-if="sim && cmp" key="h-sim" class="hero card glow rise" :class="{ mini: heroCollapsed }">
      <span class="hv"><span class="big hero-num">{{ cmp.a.output_units }}</span><small>{{ VARIANT.a }}</small></span>
      <span class="arrow">→</span>
      <span class="hv"><span class="big hero-num accent">{{ cmp.b.output_units }}</span><small class="b">{{ VARIANT.b }}</small></span>
      <div v-if="!heroCollapsed" class="hero-cap">
        <b :class="cmp.delta.output_units >= 0 ? 'pos' : 'neg'">{{ signed(cmp.delta.output_units) }} {{ plural(cmp.delta.output_units, 'машина', 'машины', 'машин') }} за смену с рекомендацией</b>
        <span>{{ stopNameCap }} встаёт в {{ wall(stopStart) }} на {{ durA }} мин.
          Рекомендация{{ scenario.bOrigin === 'ai' ? ' ИИ' : '' }}: <b>{{ measure }}</b>.
          Простой соседей {{ signed(cmp.delta.blocked_min + cmp.delta.starved_min, 0) }} мин.</span>
      </div>
      <span v-else class="mini-cap" :class="cmp.delta.output_units >= 0 ? 'pos' : 'neg'">{{ signed(cmp.delta.output_units) }}</span>
      <button class="fold" :title="heroCollapsed ? 'Развернуть' : 'Свернуть, чтобы видеть 3D'" @click="heroCollapsed = !heroCollapsed">{{ heroCollapsed ? '⤢' : '–' }}</button>
    </section>

    <section v-if="mode === 'live'" key="h-live" class="hero card glow rise" :class="{ mini: heroCollapsed, 'bad-glow': live.status === 'decision', 'good-glow': live.status === 'finished' }">
      <span class="hv"><span class="big hero-num" :class="{ accent: live.status === 'finished' }">{{ live.output ?? live.base ?? '—' }}</span><small>прогноз на 16:00</small></span>
      <div v-if="!heroCollapsed" class="hero-cap">
        <b>{{ liveHead.title }}</b>
        <span>{{ liveHead.sub }}</span>
      </div>
      <button class="fold" :title="heroCollapsed ? 'Развернуть' : 'Свернуть, чтобы видеть 3D'" @click="heroCollapsed = !heroCollapsed">{{ heroCollapsed ? '⤢' : '–' }}</button>
    </section>

    <div v-if="sim && scenario.result" class="forecast-wrap" :style="{ top: `calc(var(--top) + ${heroH + 20}px)` }">
      <ForecastCard @open-ml="showMonitor = true" />
    </div>

    <div class="scene-tools">
      <button v-if="selected" class="btn" @click="onSelect(null)">← Общий вид</button>
      <GoalsCard v-if="(mode === 'data' || (mode === 'live' && ['idle', 'finished'].includes(live.status))) && !selected" :overview="overview" @select="onSelect" />
      <div v-if="sim && !(mode === 'live' && ['idle', 'finished'].includes(live.status))" class="legend glass">
        <span class="state working" title="Участок работает">работает</span>
        <span class="state down" title="Участок остановлен (поломка/ремонт)">остановлен</span>
        <span class="state blocked" title="Участок исправен, но следующий накопитель полон — некуда отдать машину">ждёт: некуда отдать</span>
        <span class="state starved" title="Участок исправен, но перед ним пусто — нечего делать">ждёт: нет кузовов</span>
      </div>
    </div>


    <aside class="side glass rise">
      <LivePanel v-if="mode === 'live'" @explore="go('scenario')" @incidents="showIncidents = true" @need-form="onNeedForm" />
      <DataPanel v-else-if="mode === 'data'" :overview="overview" :history="history" :selected="selected" @select="onSelect" @date="loadDate" />
      <ScenarioPanel v-else-if="mode === 'scenario'" @ask-ai="go('ai')" @new-event="showEvent = true" />
      <AiAssistant v-else :status="aiStatus" />
    </aside>

    <section class="dock glass rise">
      <LiveDock v-if="mode === 'live'" />
      <DataDock v-else-if="mode === 'data'" :history="history" :date="overview?.date" :selected="selected" @select="onSelect" />
      <Timeline v-else />
    </section>


    <p class="credit"><img :src="adrusMark" alt="" /> © 2026 <b>AdRus Technology</b> · цифровой двойник производственной линии</p>
    <HelpOverlay v-if="showHelp" @close="showHelp = false" />
    <Splash v-if="showSplash" @done="showSplash = false" />
    <Tour v-if="showTour" :ctl="tourCtl" @close="showTour = false" />
    <div v-if="notice" class="notice glass rise" role="status">
      <span class="ok">✓</span>
      <span>Событие посчитано: <b>{{ notice.what }}</b> — {{ notice.effect }}. Прогноз слева, рекомендация справа<template v-if="notice.inc">, запись <b>{{ notice.inc }}</b> в журнале инцидентов</template>.</span>
      <button class="fold" aria-label="Закрыть" @click="notice = null">×</button>
    </div>
    <EventForm v-if="showEvent" :reasons="reasons" :equipment="equipment" :initial="eventInitial" @close="closeEvent" @done="onEventDone" />
    <MonitorDialog v-if="showMonitor" @close="showMonitor = false" @done="onMonitorDone" />
    <IncidentsDialog v-if="showIncidents" :downtimes="downtimes" @close="showIncidents = false" @open="onOpenIncident" @new="onNewFromIncidents" />
  </div>
</template>

<style scoped>
.app { position: relative; height: 100%; overflow: hidden; --side-w: 404px; --gap: 14px; --dock-h: 248px; --top: 84px; }
.stage { position: absolute; inset: 0; z-index: 0; isolation: isolate; }
.app.still :deep(*), .app.still * { transition: none !important; animation: none !important; }
.stage::after {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background:
    linear-gradient(180deg, rgba(6,8,12,.55), transparent 18%, transparent 72%, rgba(6,8,12,.45)),
    radial-gradient(60% 50% at 10% 0%, rgba(184,148,255,.18), transparent 70%),
    radial-gradient(50% 50% at 60% 0%, rgba(76,196,255,.12), transparent 70%);
}

.topbar {
  position: absolute; top: var(--gap); left: var(--gap); right: var(--gap);
  display: flex; align-items: center; gap: 14px; padding: 8px 10px 8px 16px; border-radius: 22px;
}
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1; }
.brand .title { min-width: 0; padding-left: 12px; border-left: 1px solid var(--line-strong); }
.brand h1 { font-size: 14px; line-height: 1.15; font-weight: 600; letter-spacing: .01em; max-width: 240px; }
.brand p { font-size: 11px; color: var(--ink-3); letter-spacing: .04em; white-space: nowrap; margin-top: 2px; }
.dev { display: grid; gap: 1px; padding-left: 12px; border-left: 1px solid var(--line-strong); flex: none; }
.dev small { font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--ink-3); }
.dev img { height: 28px; width: auto; display: block; }
.mark { width: 56px; height: 19px; flex: none; }

.steps { display: flex; align-items: center; gap: 6px; }
.step {
  display: flex; align-items: center; gap: 8px; text-align: left; cursor: pointer;
  padding: 8px 16px; border-radius: 16px; border: 1px solid var(--line); background: rgba(0,0,0,.2);
  transition: background .2s, border-color .2s, transform .2s;
}
.step:hover { border-color: var(--line-strong); transform: translateY(-1px); }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--down); opacity: .6; flex: none; }
.live-dot.run { opacity: 1; box-shadow: 0 0 10px var(--down); animation: pulse-dot 1.4s infinite; }
.step .t { display: grid; line-height: 1.15; }
.step b { font-size: 14px; font-weight: 600; }
.step small { font-size: 11px; color: var(--ink-3); }
.step.on { border-color: transparent; background: linear-gradient(135deg, rgba(220,255,79,.22), rgba(76,196,255,.14)); box-shadow: inset 0 0 0 1px rgba(220,255,79,.45); }
.step.ai.on { background: linear-gradient(135deg, rgba(184,148,255,.3), rgba(76,196,255,.18)); box-shadow: inset 0 0 0 1px rgba(184,148,255,.6); }

.toggles { display: flex; gap: 6px; flex: 1; justify-content: flex-end; }
.icon-btn { width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--line-strong); background: rgba(255,255,255,.06); cursor: pointer; font-weight: 700; }
.icon-btn:hover { background: var(--accent); color: var(--accent-ink); }
.chip { cursor: pointer; }
.chip input { accent-color: var(--accent); margin: 0; }
.load-error { position: absolute; top: var(--top); left: 50%; transform: translateX(-50%); padding: 10px 16px; color: var(--down); }

.hero {
  position: absolute; top: calc(var(--top) + 6px); left: var(--gap); pointer-events: none;
  max-width: calc(100% - var(--side-w) - 330px); padding: 8px 12px 8px 18px; transition: opacity .4s;
  box-shadow: 0 14px 40px rgba(0,0,0,.4); display: flex; align-items: center; gap: 12px; border-radius: 18px;
}
.hero.mini { padding: 4px 8px 4px 14px; gap: 8px; }
.hero.mini .hero-num { font-size: 30px; }
.hero.mini .arrow { font-size: 18px; }
.mini-cap { font-size: 13px; color: var(--ink-2); white-space: nowrap; }
.mini-cap.pos { color: var(--ok); font-weight: 700; font-size: 16px; }
.mini-cap.neg { color: var(--down); font-weight: 700; font-size: 16px; }
.fold {
  pointer-events: auto; margin-left: 4px; width: 26px; height: 26px; flex: none; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--line-strong); background: rgba(255,255,255,.06); color: var(--ink-2); font-size: 16px; line-height: 1;
}
.fold:hover { background: var(--accent); color: var(--accent-ink); }
.app.focused .hero { opacity: .25; }
.eyebrow { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 6px; }
.hero-row { display: flex; align-items: center; gap: 16px; }
.hero-num { font-size: 46px; color: var(--ink); }
.hero-num small { font-size: .45em; margin-left: 2px; color: var(--ink-2); }
.hero-num.down { color: var(--down); }
.hero-num.accent { background: linear-gradient(90deg, #dcff4f, #3ee8a9); -webkit-background-clip: text; background-clip: text; color: transparent; }
.variant { display: grid; }
.variant small { font-size: 11px; color: var(--ink-3); letter-spacing: .06em; text-transform: uppercase; }
.arrow { font-size: 30px; color: var(--ink-3); font-weight: 200; }
.hero-cap { display: grid; gap: 3px; font-size: 13px; color: var(--ink-2); }
.hero-cap b { font-size: 15px; color: var(--ink); font-weight: 600; }
.hero-cap b.pos { color: var(--ok); }
.hero-cap b.neg { color: var(--down); }
.hero-cap span b { font-size: inherit; color: var(--ink); }
.hv { display: grid; justify-items: center; line-height: 1; }
.hv small { font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3); white-space: nowrap; margin-top: 2px; }
.hv small.b { color: var(--accent); }
.hero.mini .hv small { display: none; }
.notice {
  position: absolute; z-index: 30; left: calc((100% - var(--side-w)) / 2); bottom: calc(var(--dock-h) + 2 * var(--gap)); transform: translateX(-50%);
  display: flex; align-items: center; gap: 12px; padding: 10px 12px 10px 16px; border-radius: 14px; max-width: min(720px, 90vw);
  border: 1px solid rgba(62,232,169,.5); box-shadow: 0 0 30px rgba(62,232,169,.18), 0 14px 40px rgba(0,0,0,.5); font-size: 13.5px; color: var(--ink-2);
}
.notice b { color: var(--ink); }
.notice .ok { color: var(--ok); font-size: 18px; }

.tour-btn { padding: 6px 12px; border-radius: 999px; border-color: rgba(220,255,79,.55); color: var(--accent); font-weight: 600; }
.tour-btn:hover { background: var(--accent); color: var(--accent-ink); }
.event-btn { border-color: rgba(255,77,97,.5); color: var(--ink); padding: 6px 12px; border-radius: 999px; }
.event-btn:hover { background: var(--down-bg); border-color: var(--down); }
.inc-btn { padding: 6px 12px; border-radius: 999px; display: inline-flex; align-items: center; gap: 6px; }
.ml-tag { font-size: 9.5px; font-weight: 800; letter-spacing: .08em; padding: 1px 6px; border-radius: 999px; color: #12081f; background: linear-gradient(135deg, #b894ff, #4cc4ff); }
.badge.warn { background: var(--blocked); color: #1a1003; }
.badge { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: var(--down); color: #1a0306; font-size: 11px; font-weight: 800; display: inline-grid; place-items: center; }
.forecast-wrap { position: absolute; left: var(--gap); z-index: 1; pointer-events: auto; }
.app.focused .forecast-wrap { opacity: .9; }
.scene-tools {
  position: absolute; top: calc(var(--top) + 6px); right: calc(var(--side-w) + var(--gap) * 2);
  display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
}
.legend { display: grid; gap: 6px; padding: 10px; border-radius: 14px; justify-items: start; }

.ask-ai {
  position: absolute; right: calc(var(--side-w) + var(--gap) * 2); bottom: calc(var(--dock-h) + var(--gap) * 2);
  display: flex; align-items: center; gap: 12px; padding: 10px 18px 10px 10px; border-radius: 999px; cursor: pointer;
  border: 1px solid rgba(184,148,255,.5); color: var(--ink); text-align: left;
  background: linear-gradient(135deg, rgba(40,30,70,.92), rgba(18,30,48,.92));
  box-shadow: 0 10px 40px rgba(110,90,255,.35); transition: transform .2s, box-shadow .2s;
}
.ask-ai:hover { transform: translateY(-2px); box-shadow: 0 14px 50px rgba(110,90,255,.55); }
.ask-ai span:last-child { display: grid; line-height: 1.15; }
.ask-ai b { font-size: 15px; }
.ask-ai small { font-size: 11px; color: var(--ink-2); }
.orb {
  width: 34px; height: 34px; border-radius: 50%; flex: none;
  background: conic-gradient(from 0deg, #b894ff, #4cc4ff, #dcff4f, #b894ff);
  box-shadow: 0 0 20px rgba(184,148,255,.7); animation: orb 6s linear infinite;
}

.side { position: absolute; top: var(--top); right: var(--gap); bottom: var(--gap); width: var(--side-w); overflow-y: auto; animation-delay: .15s; }
.dock { position: absolute; left: var(--gap); right: calc(var(--side-w) + var(--gap) * 2); bottom: var(--gap); height: var(--dock-h); overflow: hidden; animation-delay: .25s; }
.credit {
  position: absolute; left: var(--gap); bottom: calc(var(--dock-h) + var(--gap) + 8px); margin: 0;
  font-size: 11px; color: var(--ink-2); pointer-events: none; background: rgba(10,14,20,.7); padding: 3px 10px; border-radius: 999px;
}
.credit { display: flex; align-items: center; gap: 6px; }
.credit img { height: 13px; width: auto; }
.credit b { color: var(--ink); }

@media (max-height: 760px) {
  .app { --dock-h: 216px; }
  .hero-num { font-size: 40px; }
}
@media (max-width: 1800px) {
  .step small, .brand .title p { display: none; }
  .brand h1 { font-size: 13px; max-width: 200px; }
}
@media (max-width: 1460px) {
  .step { padding: 8px 11px; }
  .step b { font-size: 13px; }
}
@media (max-width: 1350px) {
  .hero { max-width: calc(100% - var(--side-w) - 300px); }
}
@media (max-width: 1100px) {
  .app { --side-w: 340px; }
  .toggles .chip:last-child { display: none; }
}
</style>
