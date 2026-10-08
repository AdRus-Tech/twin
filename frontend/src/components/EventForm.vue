<script setup>
// Ввод события руководителем смены: какой участок встал, во сколько и сколько
// займёт ремонт. Событие сразу считается моделью: последствия для соседей,
// прогноз без мер и рекомендация — ремонт вдвое быстрее.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { applyEvent, scenario, wall } from '../scenario'
import { injectEvent, live } from '../live'

const props = defineProps({ reasons: { type: Array, default: () => [] }, equipment: { type: Array, default: () => [] }, initial: { type: Object, default: null } })
const emit = defineEmits(['close', 'done'])

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN
}
const toHHMM = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

const stations = computed(() => scenario.a?.stations ?? [])
// Если пришли из сообщения с линии — подставляем то, что удалось разобрать.
const station = ref(props.initial?.station ?? scenario.event?.station ?? scenario.a?.stoppage?.station ?? stations.value[0]?.id)
const shiftStart = ref(toHHMM(scenario.shiftStart))
const time = ref(toHHMM(scenario.shiftStart + (scenario.event?.start ?? scenario.a?.stoppage?.start_min ?? 120)))
const duration = ref(props.initial?.duration_min ?? scenario.event?.duration ?? 30)
const reason = ref(props.initial?.reason ?? scenario.event?.reason ?? '')
const equipmentName = ref(props.initial?.equipment ?? scenario.event?.equipment ?? '')
// Оборудование выбранного участка — из журнала простоев (участок совпадает по названию).
const stationEquipment = computed(() => {
  const name = stations.value.find((s) => s.id === station.value)?.name
  return props.equipment.filter((e) => e.section === name).map((e) => e.name)
})
const error = ref(null)
const busy = ref(false)

// Подсказка: какой это момент смены.
const offset = computed(() => {
  const d = toMin(time.value) - toMin(shiftStart.value)
  return Number.isFinite(d) ? d : null
})
const horizon = computed(() => scenario.a?.horizon_min ?? 480)

async function submit() {
  error.value = null
  const start = toMin(shiftStart.value)
  const at = toMin(time.value)
  if (!Number.isFinite(start) || !Number.isFinite(at)) {
    error.value = 'Укажите время в формате ЧЧ:ММ.'
    return
  }
  if (!(duration.value >= 1 && duration.value <= 960)) {
    error.value = 'Ремонт — от 1 до 960 минут.'
    return
  }
  busy.value = true
  try {
    // В идущей смене событие происходит «сейчас» — время не спрашиваем.
    if (scenario.live) {
      const eq = stationEquipment.value.includes(equipmentName.value) ? equipmentName.value : ''
      const evt = { station: station.value, duration: duration.value, reason: reason.value, equipment: eq, message: props.initial?.message ?? '', parsedBy: props.initial?.source ?? '' }
      await injectEvent(evt)
      emit('done')
      return
    }
    scenario.shiftStart = start
    const eq = stationEquipment.value.includes(equipmentName.value) ? equipmentName.value : ''
    await applyEvent({ station: station.value, clockMin: at, duration: Math.round(duration.value), reason: reason.value, equipment: eq })
    if (scenario.error) throw new Error(scenario.error)
    emit('done')
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

const onKey = (e) => e.key === 'Escape' && emit('close')
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="ev-title" @click.self="emit('close')">
    <form class="card glow box rise" @submit.prevent="submit">
      <button type="button" class="close" aria-label="Закрыть" @click="emit('close')">×</button>
      <h2 id="ev-title">Событие на линии</h2>
      <p class="lead">Участок встал? Укажите, где и на сколько, — модель сразу покажет, кого и когда это заденет.</p>
      <p v-if="props.initial?.message" class="from-msg">Из сообщения «{{ props.initial.message }}» не удалось понять: {{ props.initial.missing.map((m) => (m === 'station' ? 'участок' : 'длительность')).join(' и ') }} — уточните.</p>

      <label class="field">Какой участок встал
        <select id="ev-station" v-model="station">
          <option v-for="s in stations" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </label>

      <label v-if="stationEquipment.length" class="field"><span>Оборудование <span class="opt">необязательно</span></span>
        <select id="ev-equipment" v-model="equipmentName">
          <option value="">не указано</option>
          <option v-for="e in stationEquipment" :key="e" :value="e">{{ e }}</option>
        </select>
      </label>

      <p v-if="scenario.live" class="hint">Время события — сейчас, <b>{{ wall(live.t) }}</b>.</p>
      <div class="row">
        <label v-if="!scenario.live" class="field">Во сколько встал
          <input id="ev-time" v-model="time" type="time" required />
        </label>
        <label class="field">Ремонт займёт, мин
          <input id="ev-duration" v-model.number="duration" type="number" min="1" max="960" required />
        </label>
      </div>

      <label class="field"><span>Причина <span class="opt">необязательно</span></span>
        <input id="ev-reason" v-model="reason" list="ev-reasons" maxlength="80" placeholder="например, замена фильтра" />
        <datalist id="ev-reasons"><option v-for="r in props.reasons" :key="r" :value="r" /></datalist>
      </label>

      <details v-if="!scenario.live" class="more">
        <summary>Смена и допущения</summary>
        <label class="field inline">Начало смены
          <input id="ev-shift" v-model="shiftStart" type="time" required />
        </label>
        <p class="muted small">Смена {{ horizon / 60 }} ч: с {{ shiftStart }} до {{ toHHMM(toMin(shiftStart) + horizon) }}. Такты и накопители — из настроек модели (условные). Остановка считается полной.</p>
      </details>

      <p v-if="offset !== null && !scenario.live" class="hint" :class="{ bad: offset < 0 || offset >= horizon }">
        <template v-if="offset >= 0 && offset < horizon">Это {{ Math.floor(offset / 60) }} ч {{ offset % 60 }} мин от начала смены.</template>
        <template v-else>Время вне смены ({{ shiftStart }}–{{ toHHMM(toMin(shiftStart) + horizon) }}).</template>
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <div class="actions">
        <button type="button" class="btn" @click="emit('close')">Отмена</button>
        <button type="submit" class="btn primary" :disabled="busy">{{ busy ? 'Считаем…' : 'Рассчитать последствия' }}</button>
      </div>
      <p class="muted small">Модель покажет прогноз без мер и рекомендацию. Событие сохраняется в журнал инцидентов.</p>
    </form>
  </div>
</template>

<style scoped>
.overlay { position: absolute; inset: 0; z-index: 20; display: grid; place-items: center; background: rgba(4,6,10,.72); }
.box { width: min(460px, 92vw); padding: 24px; display: grid; gap: 12px; position: relative; }
.close { position: absolute; top: 12px; right: 14px; font-size: 26px; background: none; border: 0; cursor: pointer; color: var(--ink-2); }
h2 { font-size: 20px; letter-spacing: 0; text-transform: none; color: var(--ink); }
.lead { font-size: 13px; color: var(--ink-2); }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.opt { color: var(--ink-3); font-size: 11px; margin-left: 4px; }
.more summary { cursor: pointer; font-size: 12px; color: var(--ink-3); }
.more[open] { display: grid; gap: 8px; }
.inline { max-width: 180px; margin-top: 8px; }
.hint { font-size: 12.5px; color: var(--ink-2); }
.from-msg { font-size: 12.5px; color: var(--blocked); border-left: 2px solid var(--blocked); padding: 4px 10px; }
.hint.bad, .error { color: var(--down); font-size: 13px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
.actions .primary { padding: 10px 16px; }
.small { font-size: 11px; }
</style>
