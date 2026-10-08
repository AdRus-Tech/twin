<script setup>
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { LineScene, webglAvailable } from '../scene/LineScene'
import SchemeFallback from './SchemeFallback.vue'

const props = defineProps({
  mode: String, // 'data' | 'scenario'
  dataNodes: Array,
  frame: Object,
  stations: Array,
  buffers: Array,
  eta: Object, // ближайший прогнозируемый простой по участкам: { id: { state, in } }
  selected: String,
  prefer2d: Boolean,
  reducedMotion: Boolean,
  topExtra: { type: Number, default: 0 }, // высота подложки с выводом над сценой
})
const emit = defineEmits(['select'])

const host = ref(null)
const scene = shallowRef(null)
const hasWebgl = webglAvailable()
const failed = ref(false)

// Отступы под панели: читаются из CSS-переменных .app, чтобы не дублировать размеры.
function insets() {
  const st = getComputedStyle(host.value.closest('.app'))
  const px = (name) => parseFloat(st.getPropertyValue(name)) || 0
  const gap = px('--gap')
  return { top: px('--top') + props.topExtra + gap, right: px('--side-w') + gap * 2, bottom: px('--dock-h') + gap, left: 0 }
}

function mount() {
  if (scene.value || !host.value || props.prefer2d || !hasWebgl) return
  try {
    scene.value = new LineScene(host.value, { onSelect: (id) => emit('select', id) })
    scene.value.setReducedMotion(props.reducedMotion)
    scene.value.setInsets(insets())
    push()
    if (props.selected) scene.value.select(props.selected)
  } catch (e) {
    console.error(e)
    failed.value = true
  }
}

function unmount() {
  scene.value?.dispose()
  scene.value = null
}

function push() {
  const s = scene.value
  if (!s) return
  if (props.mode === 'scenario' && props.frame && props.stations) {
    s.setSimFrame(props.frame, props.stations, props.buffers || [], props.eta || {})
  } else if (props.dataNodes) {
    s.setDataNodes(props.dataNodes)
  }
}

function onWindowResize() {
  scene.value?.setInsets(insets())
}

onMounted(() => {
  mount()
  window.addEventListener('resize', onWindowResize)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  unmount()
})

watch(() => [props.mode, props.dataNodes, props.frame, props.stations, props.buffers, props.eta], push)
watch(() => props.selected, (id) => (id ? scene.value?.select(id) : scene.value?.resetView()))
watch(() => props.reducedMotion, (v) => scene.value?.setReducedMotion(v))
watch(() => props.topExtra, () => scene.value?.setInsets(insets()))
watch(() => props.prefer2d, async (v) => {
  if (v) unmount()
  else {
    await Promise.resolve()
    mount()
  }
})

const show3d = () => hasWebgl && !failed.value && !props.prefer2d
</script>

<template>
  <div class="scene-view">
    <div v-show="show3d()" ref="host" class="host" aria-label="3D-схема цепочки участков"></div>
    <div v-if="!show3d()" class="fallback">
      <SchemeFallback
        :mode="mode" :data-nodes="dataNodes" :frame="frame" :stations="stations" :buffers="buffers"
        :selected="selected" @select="emit('select', $event)"
      />
      <p v-if="!hasWebgl || failed" class="fallback-note">WebGL недоступен — показана плоская схема. Аналитика работает полностью.</p>
    </div>
  </div>
</template>

<style scoped>
.scene-view { position: absolute; inset: 0; }
.host { position: absolute; inset: 0; overflow: hidden; }
.fallback {
  position: absolute; top: calc(var(--top) + 110px); left: var(--gap);
  right: calc(var(--side-w) + var(--gap) * 2); bottom: calc(var(--dock-h) + var(--gap) * 2 + 20px);
  display: grid; place-items: center;
}
.fallback-note { font-size: 12px; color: var(--ink-2); }
</style>

<style>
/* Подписи CSS2DRenderer живут вне scoped-области. */
.scene-labels { position: absolute; inset: 0; pointer-events: none; isolation: isolate; z-index: 0; }
.node-label {
  display: grid; justify-items: center; gap: 4px;
  background: rgba(10, 14, 20, .88);
  border: 1px solid rgba(255,255,255,.12);
  padding: 6px 10px 7px; border-radius: 12px; font-size: 12px; white-space: nowrap; color: var(--ink);
  box-shadow: 0 8px 24px rgba(0,0,0,.4);
  transition: border-color .3s, box-shadow .3s;
}
.node-label b { font-weight: 600; font-size: 13px; white-space: normal; max-width: 120px; text-align: center; line-height: 1.15; letter-spacing: .01em; }
.node-label small { color: var(--ink-2); font-size: 12px; }
.node-label.ghost { opacity: .6; border-style: dashed; box-shadow: none; }
.node-label[data-severity="critical"] { border-color: rgba(255,77,97,.6); box-shadow: 0 0 24px rgba(255,77,97,.25); }
.node-label[data-severity="critical"] small { color: var(--down); font-weight: 700; font-size: 14px; }
.node-label[data-state="down"] { border-color: rgba(255,77,97,.7); box-shadow: 0 0 28px rgba(255,77,97,.35); }
.node-label[data-state="blocked"] { border-color: rgba(255,178,36,.6); }
.node-label[data-state="starved"] { border-color: rgba(76,196,255,.6); }
.node-label .eta { color: var(--blocked); font-size: 11.5px; font-weight: 700; letter-spacing: .02em; }
.node-label .eta.starved { color: var(--starved); }
.buffer-label {
  display: flex; align-items: center; gap: 6px;
  background: rgba(10, 14, 20, .8); border: 1px solid rgba(255,255,255,.12);
  padding: 3px 8px; border-radius: 999px; font-size: 12px; color: var(--ink);
}
.buffer-label .lvl { font-size: 15px; font-weight: 600; font-stretch: 75%; }
.buffer-label .lvl i { font-style: normal; color: var(--ink-3); font-weight: 400; }
</style>
