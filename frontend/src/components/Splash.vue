<script setup>
// Заставка при открытии: команда-разработчик и продукт. Клик или 2,4 с — и она уходит.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import logo from '../assets/adrus-logo.webp'

const emit = defineEmits(['done'])
const leaving = ref(false)
let timer = null

function close() {
  if (leaving.value) return
  leaving.value = true
  setTimeout(() => emit('done'), 500)
}

onMounted(() => (timer = setTimeout(close, 2400)))
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="splash" :class="{ leaving }" role="dialog" aria-label="AdRus Technology" @click="close">
    <div class="inner">
      <img class="logo" :src="logo" alt="AdRus Technology" />
      <p class="pre">представляет</p>
      <div class="rule" aria-hidden="true"></div>
      <p class="product">Цифровой двойник автомобильного завода</p>
    </div>
  </div>
</template>

<style scoped>
.splash {
  position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; cursor: pointer;
  background: radial-gradient(70% 60% at 50% 45%, rgba(76,196,255,.12), transparent 70%), #06080c;
  transition: opacity .5s ease;
}
.splash.leaving { opacity: 0; pointer-events: none; }
.inner { display: grid; justify-items: center; gap: 10px; text-align: center; padding: 24px; animation: in .9s cubic-bezier(.2,.8,.2,1) both; }
.pre { font-size: 13px; letter-spacing: .28em; text-transform: uppercase; color: var(--ink-3); }
.logo { width: min(560px, 76vw); height: auto; margin-bottom: 6px; filter: drop-shadow(0 10px 40px rgba(216, 250, 54, .18)); }
.rule { width: 120px; height: 2px; margin: 8px 0 4px; background: linear-gradient(90deg, transparent, #dcff4f, transparent); }
.product { font-size: clamp(16px, 2vw, 22px); color: var(--ink); }
@keyframes in { from { opacity: 0; transform: translateY(16px) scale(.98); } to { opacity: 1; transform: none; } }
</style>
