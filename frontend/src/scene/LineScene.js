// 3D-сцена цепочки участков: процедурный цех с роботами, конвейерами и машинами.
// Объекты — условные обозначения, а не планировка завода: размеры, число
// роботов и расположение оборудования не отражают реальный цех.
// Бегущие по линии машины — визуальный индикатор потока; численные очереди
// показывают только кузова в накопителях.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js'
import { CAR_TYPES, METER, PAINT, carGeometries, carMesh, createCarMaterials, disposeCarGeometries, partsGeometry } from './vehicles.js'
import {
  Batch, CONVEYOR_H, assemblyLine, createFactoryMaterials, finishedLot, floorTextures, hallBackdrop,
  inspectionTunnel, paintBooth, partsStore, rollerConveyor, weldingCell,
} from './equipment.js'

const C = {
  bg: 0xd9dee4,
  flow: 0x5fd4ff,
  accent: 0xdcff4f,
  down: 0xff4d61,
  blocked: 0xffb224,
  starved: 0x4cc4ff,
  working: 0x3ee8a9,
  unlit: 0x2a313b,
  pin: 0xff4d61,
  pinWarn: 0xffb224,
}

const LAYOUT = {
  parts_store: -14.5,
  welding: -8.8,
  painting: -2.6,
  assembly: 4.0,
  quality: 10.2,
  fg_store: 14.6,
}
const SPAN = 33.5 // ширина цепочки по X с подписями
const VIEW_DIR = new THREE.Vector3(0, 0.8, 0.62).normalize()
const NAMES = {
  parts_store: 'Склад комплектующих', welding: 'Сварка', painting: 'Окраска',
  assembly: 'Сборка', quality: 'Контроль качества', fg_store: 'Склад готовой продукции',
}
const HALF = { assembly: 3.1 }
const BUFFER_X = [-5.5, 0.15]
const BUFFER_Z = 3.1
const MAX_UNITS_SHOWN = 24
const TOKENS_PER_SEGMENT = 2
// Что едет по сегменту, в зависимости от участка-отправителя.
const STAGE = { parts_store: 'parts', welding: 'biw', painting: 'painted', assembly: 'complete', quality: 'complete' }
const BELT_Y = CONVEYOR_H * METER
const SHELL_TYPES = { biw: 'crossover', painted: 'sedan' }

// Оборудование участков (строится в метрах, len — длина участка вдоль линии).
const STATIONS = {
  parts_store: (M) => partsStore(M),
  welding: (M, mats) => weldingCell(M, mats, { len: 3.6 / METER }),
  painting: (M, mats) => paintBooth(M, mats, { len: 3.4 / METER }),
  assembly: (M, mats) => assemblyLine(M, mats, { len: 6.2 / METER }),
  quality: (M, mats) => inspectionTunnel(M, mats, { len: 3.4 / METER }),
  fg_store: (M, mats, paints) => finishedLot(M, mats, paints),
}
// Машины «в работе» на участке: [тип, стадия, x в метрах].
const WIP = {
  welding: [['crossover', 'biw', 0]],
  painting: [['sedan', 'painted', 0]],
  assembly: [['crossover', 'painted', -5.6], ['hatch', 'painted', -0.4], ['sedan', 'complete', 4.8]],
  quality: [['crossover', 'complete', 0]],
}

const STATE_LABEL = { working: 'работает', down: 'остановлен', blocked: 'ждёт: некуда отдать', starved: 'ждёт: нет кузовов' }
const ETA_LABEL = { blocked: 'некуда отдать', starved: 'нет кузовов' }

export function webglAvailable() {
  try {
    const c = document.createElement('canvas')
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')))
  } catch {
    return false
  }
}

function radialTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.35, 'rgba(255,255,255,.45)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function hatchTexture() {
  const c = document.createElement('canvas')
  c.width = 168
  c.height = 200
  const g = c.getContext('2d')
  const b = 10
  g.save()
  g.beginPath()
  g.rect(0, 0, 168, 200)
  g.rect(b, b, 168 - 2 * b, 200 - 2 * b)
  g.clip('evenodd')
  g.fillStyle = '#f2c230'
  g.fillRect(0, 0, 168, 200)
  g.strokeStyle = '#1d1f22'
  g.lineWidth = 6
  for (let i = -200; i < 400; i += 16) {
    g.beginPath()
    g.moveTo(i, 0)
    g.lineTo(i + 200, 200)
    g.stroke()
  }
  g.restore()
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** Группа в метрах, вписанная в единицы сцены. */
function metric(obj) {
  const g = new THREE.Group()
  g.scale.setScalar(METER)
  g.add(obj)
  return g
}

// --- Сцена ----------------------------------------------------------------

// Подпись обновляется, только если текст изменился: лишняя перестройка DOM даёт подтормаживания.
const shownHtml = new WeakMap()
function setHtml(el, html) {
  if (shownHtml.get(el) === html) return
  el.innerHTML = html
  shownHtml.set(el, html)
}

export class LineScene {
  constructor(container, { onSelect } = {}) {
    this.container = container
    this.onSelect = onSelect
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    this.nodes = new Map()
    this.buffers = []
    this.segments = []
    this.anim = []
    this.emitters = []
    this.simStates = null
    this.selected = null
    this.hovered = null
    this.tween = null
    this.timer = new THREE.Timer()
    this.disposables = []

    const { clientWidth: w, clientHeight: h } = container
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    // Плотность пикселей ограничена: выше 1.5 картинка почти не меняется, а нагрузка растёт квадратично.
    this.maxDpr = Math.min(window.devicePixelRatio, 1.5)
    this.renderer.setPixelRatio(this.maxDpr)
    this.renderer.setSize(w, h)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    container.appendChild(this.renderer.domElement)

    this.labels = new CSS2DRenderer()
    this.labels.setSize(w, h)
    this.labels.domElement.className = 'scene-labels'
    container.appendChild(this.labels.domElement)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(C.bg)
    this.scene.fog = new THREE.Fog(C.bg, 85, 170)

    this.camera = new THREE.PerspectiveCamera(30, w / h, 0.5, 220)
    this.home = { pos: VIEW_DIR.clone().multiplyScalar(50), target: new THREE.Vector3(0, 0.4, 1.4) }
    this.camera.position.set(-34, 30, 52)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.copy(this.home.target)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 4
    this.controls.maxDistance = 90
    this.controls.maxPolarAngle = Math.PI * 0.46

    // Постобработка: MSAA-буфер, затенение в углах (GTAO), свечение ламп, тонмаппинг.
    const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 })
    this.composer = new EffectComposer(this.renderer, target)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.gtao = new GTAOPass(this.scene, this.camera, w, h)
    this.gtao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.2, scale: 1.15, samples: 12 })
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 8, rings: 2, samples: 12 })
    this.gtao.blendIntensity = 0.75
    // Полупрозрачное (стекло, «призраки», подсветка пола), точки и линии не должны отбрасывать AO.
    // Список собирается один раз и обновляется только при смене «призраков», а не обходом сцены в каждом кадре.
    this.aoDirty = true
    this.gtao._overrideVisibility = () => {
      if (this.aoDirty) {
        this.aoHidden = []
        this.scene.traverse((o) => {
          if (o.isPoints || o.isLine || o.isLine2 || o.isSprite || (o.material && o.material.transparent)) this.aoHidden.push(o)
        })
        this.aoDirty = false
      }
      for (const o of this.aoHidden) {
        if (o.visible) {
          o.visible = false
          this.gtao._visibilityCache.push(o)
        }
      }
    }
    this.composer.addPass(this.gtao)
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.35, 0.4, 1.6)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())

    this.glowTex = radialTexture()
    this.disposables.push(this.glowTex)
    this.materials = createFactoryMaterials()
    this.carMats = createCarMaterials()
    this.paints = PAINT.map((c) => Object.assign(this.carMats.paint.clone(), { color: new THREE.Color(c) }))
    this.disposables.push(...this.materials.textures, ...this.paints)
    for (const [k, v] of Object.entries(this.materials)) if (k !== 'textures') this.disposables.push(v)
    this.disposables.push(...Object.values(this.carMats))

    // Окружение: сначала нейтральная «комната», затем HDR-панорама цеха.
    this.pmrem = new THREE.PMREMGenerator(this.renderer)
    this.envTex = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environment = this.envTex
    this.scene.environmentIntensity = 0.55
    this.#loadHdr()

    this.#buildEnvironment()
    this.#buildNodes()
    this.#buildSegments()
    this.#buildBuffers()
    this.#buildTokens()
    this.#buildSparks()

    this.raycaster = new THREE.Raycaster()
    this.pointer = new THREE.Vector2()
    this.downAt = null
    this.handlers = {
      down: (e) => (this.downAt = { x: e.clientX, y: e.clientY }),
      up: (e) => this.#onPointerUp(e),
      move: (e) => this.#onPointerMove(e),
    }
    const el = this.renderer.domElement
    el.addEventListener('pointerdown', this.handlers.down)
    el.addEventListener('pointerup', this.handlers.up)
    el.addEventListener('pointermove', this.handlers.move)

    this.resizeObserver = new ResizeObserver(() => this.#resize())
    this.resizeObserver.observe(container)

    // Влёт камеры при открытии.
    this.#flyTo(this.home.pos.clone(), this.home.target.clone(), 2.4)
    this.frame = requestAnimationFrame(() => this.#loop())
  }

  async #loadHdr() {
    try {
      const hdr = await new HDRLoader().loadAsync('/env/machine_shop_02_1k.hdr')
      if (this.disposed) return hdr.dispose()
      hdr.mapping = THREE.EquirectangularReflectionMapping
      const env = this.pmrem.fromEquirectangular(hdr).texture
      hdr.dispose()
      this.envTex.dispose()
      this.envTex = env
      this.scene.environment = env
      this.scene.environmentRotation.y = 1.2
    } catch (e) {
      // Без панорамы остаются отражения от нейтральной «комнаты».
      console.warn('HDR-окружение не загружено', e)
    }
  }

  #buildEnvironment() {
    const M = this.materials
    // Свет цеха: рассеянный от кровли + основной свет через световые фонари.
    this.scene.add(new THREE.HemisphereLight(0xf4f7ff, 0x5f656c, 0.55))
    const key = new THREE.DirectionalLight(0xfff3e2, 2.1)
    key.position.set(-10, 26, 14)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.bias = -0.0003
    key.shadow.normalBias = 0.025
    key.shadow.radius = 3
    Object.assign(key.shadow.camera, { left: -26, right: 26, top: 14, bottom: -14, far: 80 })
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0xdfeaff, 0.5)
    fill.position.set(14, 10, -10)
    this.scene.add(fill)

    // Пол: эпоксидное покрытие с лёгким глянцем.
    const { map, rough } = floorTextures()
    map.repeat.set(140 / METER / 6, 70 / METER / 6) // плиты 6×6 м
    rough.repeat.set(10, 5)
    this.disposables.push(map, rough)
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(140, 70),
      new THREE.MeshStandardMaterial({ color: 0xc3c8cd, map, roughnessMap: rough, roughness: 0.55, metalness: 0.0, envMapIntensity: 0.9 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    this.scene.add(floor)

    // Разметка: жёлтые границы зоны линии, зелёный проход, отбойники вдоль прохода.
    // Слои разметки разводятся смещением глубины, а не миллиметрами по высоте: иначе издали они мерцают.
    const layer = (mat, k) => {
      const m = mat.clone()
      Object.assign(m, { polygonOffset: true, polygonOffsetFactor: -k, polygonOffsetUnits: -4 * k })
      this.disposables.push(m)
      return m
    }
    const L = { line: layer(M.line, 2), green: layer(M.green, 1), white: layer(M.white, 2), zebra: layer(M.white, 3) }
    const marks = new Batch()
    const stripe = (x0, x1, z, width, mat, y = 0.01) => marks.add(new THREE.PlaneGeometry(x1 - x0, width), mat, { x: (x0 + x1) / 2, y, z, rx: -Math.PI / 2 })
    stripe(-17.5, 17.5, -2.6, 0.06, L.line)
    stripe(-17.5, 17.5, 5.05, 0.06, L.line)
    stripe(-17.5, 17.5, 6.05, 1.5, L.green)
    stripe(-17.5, 17.5, 5.33, 0.04, L.white)
    stripe(-17.5, 17.5, 6.77, 0.04, L.white)
    // Пешеходный переход через проход — «зебра».
    for (const cx of [-11.6, 7.2]) for (let i = 0; i < 6; i++) stripe(cx + i * 0.22, cx + i * 0.22 + 0.12, 6.05, 1.36, L.zebra)
    const rails = new Batch()
    for (let x = -17; x <= 17; x += 2.0) {
      if (Math.abs(x + 11.4) < 1.2 || Math.abs(x - 7.4) < 1.2) continue
      rails.box(0.07, 0.36, 0.07, M.yellow, { x, y: 0.18, z: 5.2 })
      if (x + 2 <= 17 && Math.abs(x + 2 + 11.4) >= 1.2 && Math.abs(x + 2 - 7.4) >= 1.2) {
        rails.box(2.0, 0.07, 0.04, M.yellow, { x: x + 1, y: 0.3, z: 5.2 })
        rails.box(2.0, 0.07, 0.04, M.yellow, { x: x + 1, y: 0.16, z: 5.2 })
      }
    }
    this.scene.add(marks.build(), rails.build())

    // Стена цеха позади линии.
    const hall = metric(hallBackdrop(M, { from: -19.5 / METER, to: 19.5 / METER, z: -7.5 / METER }))
    this.scene.add(hall)
  }

  #buildNodes() {
    for (const [id, x] of Object.entries(LAYOUT)) {
      const group = new THREE.Group()
      group.position.x = x
      group.userData.nodeId = id
      const station = STATIONS[id](this.materials, this.carMats, this.paints)
      const model = metric(station.group)
      group.add(model)
      // Машины «в работе» на участке.
      const wip = new THREE.Group()
      let ci = id.length
      for (const [type, stage, mx] of WIP[id] ?? []) {
        ci += 1
        const paint = stage === 'painted' ? this.#openPaint(ci % PAINT.length) : this.paints[ci % PAINT.length]
        const car = carMesh(type, this.carMats, paint, stage)
        car.position.set(mx * METER, station.wipY * METER, 0)
        wip.add(car)
      }
      group.add(wip)
      group.traverse((o) => {
        if (o.isMesh) o.userData.kit = true
      })
      station.robots.forEach((r, i) => {
        this.anim.push({ node: id, robot: r, phase: i * 1.7 + x, speed: 1.1 + (i % 2) * 0.25 })
        if (id === 'welding') this.emitters.push({ node: id, tip: r.tip, phase: i * 0.9 })
      })

      const wide = (HALF[id] ?? 1.7) * 2 + 0.6
      // Световое пятно состояния под участком.
      const pool = new THREE.Mesh(
        new THREE.PlaneGeometry(wide + 2.5, 6),
        new THREE.MeshBasicMaterial({ map: this.glowTex, color: C.working, transparent: true, opacity: 0, depthWrite: false }),
      )
      pool.rotation.x = -Math.PI / 2
      pool.position.y = 0.015
      group.add(pool)

      // Рамка выделения на полу.
      const sel = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(wide, 4.6)),
        new THREE.LineBasicMaterial({ color: C.accent, transparent: true, opacity: 0 }),
      )
      sel.rotation.x = -Math.PI / 2
      sel.position.y = 0.03
      group.add(sel)

      // Невидимый объём для выбора участка мышью.
      const hit = new THREE.Mesh(new THREE.BoxGeometry(wide, 2.4, 4.4), new THREE.MeshBasicMaterial({ visible: false }))
      hit.position.y = 1.2
      group.add(hit)

      // Сигнальная колонна: сверху вниз — остановка, блокировка, нет потока, работа.
      const beacon = new THREE.Group()
      const lamps = {}
      ;['down', 'blocked', 'starved', 'working'].forEach((state, i) => {
        const lamp = new THREE.Mesh(
          new THREE.CylinderGeometry(0.11, 0.11, 0.16, 20),
          new THREE.MeshStandardMaterial({ color: C.unlit, emissive: 0x000000, roughness: 0.25, transparent: true, opacity: 0.92 }),
        )
        lamp.position.y = 2.25 - i * 0.17
        lamps[state] = lamp
        beacon.add(lamp)
      })
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.11, 0.05, 20), this.materials.dark)
      cap.position.y = 2.355
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.75, 8), this.materials.steel)
      pole.position.y = 0.875
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.04, 16), this.materials.dark)
      foot.position.y = 0.02
      beacon.add(cap, pole, foot)
      beacon.position.set((HALF[id] ?? 1.7) + 0.15, 0, -1.7)
      beacon.visible = false
      group.add(beacon)

      // Маркер исторического отклонения (режим тестовых данных).
      const pin = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.28),
        new THREE.MeshBasicMaterial({ color: C.pin }),
      )
      pin.position.y = 2.45
      pin.visible = false
      group.add(pin)

      const el = document.createElement('div')
      el.className = 'node-label'
      const label = new CSS2DObject(el)
      label.position.set(0, id === 'quality' ? 2.6 : 3.2, -0.6)
      group.add(label)

      this.scene.add(group)
      this.nodes.set(id, { id, group, sel, pool, beacon, lamps, pin, hit, wip, el, x, ghost: false, poolTarget: 0, pulse: false })
    }
  }

  /** Краска без стёкол (кузов после окраски, до сборки). */
  #openPaint(i) {
    const m = Object.assign(this.carMats.paintOpen.clone(), { color: new THREE.Color(PAINT[i]) })
    this.disposables.push(m)
    return m
  }

  #buildSegments() {
    const ids = Object.keys(LAYOUT)
    const b = new Batch()
    for (let i = 0; i < ids.length - 1; i++) {
      const x0 = LAYOUT[ids[i]] + (HALF[ids[i]] ?? 1.7)
      const x1 = LAYOUT[ids[i + 1]] - (HALF[ids[i + 1]] ?? 1.7)
      const len = x1 - x0
      rollerConveyor(b, this.materials, len / METER, { x: (x0 + len / 2) / METER })
      this.segments.push({ from: ids[i], to: ids[i + 1], x0, len, speed: 0, active: false, phase: i * 0.37 })
    }
    this.scene.add(metric(b.build()))
  }

  #buildBuffers() {
    const M = this.materials
    const geo = carGeometries()
    BUFFER_X.forEach((x, index) => {
      const group = new THREE.Group()
      group.position.set(x, 0, BUFFER_Z)
      const padMat = new THREE.MeshBasicMaterial({ map: this.glowTex, color: C.flow, transparent: true, opacity: 0.25, depthWrite: false })
      const pad = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 4.4), padMat)
      pad.rotation.x = -Math.PI / 2
      pad.position.y = 0.014
      group.add(pad)
      // Зона накопителя: жёлто-чёрная штриховка по краю, как на заводском полу.
      const hatchTex = hatchTexture()
      this.disposables.push(hatchTex)
      const frame = new THREE.Mesh(
        new THREE.PlaneGeometry(2.75, 3.45),
        new THREE.MeshStandardMaterial({ map: hatchTex, transparent: true, roughness: 0.7, depthWrite: false }),
      )
      frame.rotation.x = -Math.PI / 2
      frame.position.y = 0.012
      frame.receiveShadow = true
      group.add(frame)

      // Накопитель: нижний ярус — кузова на полу на салазках, верхние ярусы
      // стеллажа появляются, только когда кузовов больше, чем мест внизу.
      const cols = [-0.93, -0.31, 0.31, 0.93]
      const rows = [-0.8, 0.8]
      const levelH = 0.56
      const skids = new Batch()
      for (const cx of cols) for (const rz of rows) for (const s of [-0.13, 0.13]) skids.box(0.04, 0.03, 1.5, M.dark, { x: cx + s, y: 0.015, z: rz })
      group.add(skids.build())
      const levels = [1, 2].map((l) => {
        const rack = new Batch()
        const top = l * levelH
        for (const cx of [-1.24, 0, 1.24]) for (const rz of [-1.6, 0, 1.6]) rack.box(0.035, top, 0.035, M.frame, { x: cx, y: top / 2, z: rz })
        for (const rz of [-1.6, 0, 1.6]) rack.box(2.52, 0.04, 0.035, M.orange, { y: top - 0.02, z: rz })
        for (const cx of cols) for (const s of [-0.13, 0.13]) rack.box(0.03, 0.025, 3.2, M.steel, { x: cx + s, y: top - 0.02 })
        const g = rack.build()
        g.visible = false
        group.add(g)
        return g
      })
      const stage = index === 0 ? 'biw' : 'painted'
      const shell = geo[SHELL_TYPES[stage]].shell
      const unitMat = (index === 0 ? this.carMats.steel : this.carMats.paintOpen).clone()
      Object.assign(unitMat, { emissive: new THREE.Color(C.flow), emissiveIntensity: 0.06 })
      this.disposables.push(unitMat)
      const units = new THREE.InstancedMesh(shell, unitMat, MAX_UNITS_SHOWN)
      units.castShadow = true
      units.receiveShadow = true
      const m = new THREE.Matrix4()
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
      const sc = new THREE.Vector3(0.82, 0.82, 0.82)
      const color = new THREE.Color()
      for (let i = 0; i < MAX_UNITS_SHOWN; i++) {
        const layer = Math.floor(i / 8)
        const slot = i % 8
        m.compose(new THREE.Vector3(cols[slot % 4], layer * levelH + 0.01, rows[Math.floor(slot / 4)]), q, sc)
        units.setMatrixAt(i, m)
        units.setColorAt(i, color.setHex(index === 0 ? 0xffffff : PAINT[i % PAINT.length]))
      }
      units.count = 0
      group.add(units)
      const el = document.createElement('div')
      el.className = 'buffer-label'
      const label = new CSS2DObject(el)
      label.position.set(0, 0.2, 2.05)
      group.add(label)
      group.visible = false
      this.scene.add(group)
      this.buffers.push({ index, group, units, unitMat, padMat, el, levels })
    })
  }

  #buildTokens() {
    // Машины на линии: детали → сварной кузов → окрашенный → собранный.
    const max = this.segments.length * TOKENS_PER_SEGMENT
    const make = (geo, mat, colored = false) => {
      const mesh = new THREE.InstancedMesh(geo, mat, max)
      mesh.count = 0
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.frustumCulled = false
      if (colored) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3)
      this.scene.add(mesh)
      return mesh
    }
    const geo = carGeometries()
    const mats = this.carMats
    this.fleet = CAR_TYPES.map((type) => {
      const g = geo[type]
      return {
        biw: [make(g.shell, mats.steel)],
        painted: [make(g.shell, mats.paintOpen, true)],
        complete: Object.entries(g.complete).map(([k, gm]) => make(gm, mats[k], k === 'paint')),
      }
    })
    const parts = partsGeometry()
    this.disposables.push(parts.wood, parts.metal)
    this.partsMeshes = [make(parts.wood, this.materials.wood), make(parts.metal, this.carMats.steel)]
    this.tokenMatrix = new THREE.Matrix4()
    this.tokenColor = new THREE.Color()
    this.tokenScale = new THREE.Vector3(1, 1, 1)
    this.tokenQuat = new THREE.Quaternion()
    this.tokenPos = new THREE.Vector3()
  }

  #buildSparks() {
    // Искры точечной сварки: пул частиц и вспышка у электрода.
    const N = 420
    const geo = new THREE.BufferGeometry()
    this.sparkPos = new Float32Array(N * 3).fill(-100)
    this.sparkVel = new Float32Array(N * 3)
    this.sparkLife = new Float32Array(N)
    geo.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3))
    const mat = new THREE.PointsMaterial({
      size: 0.05, map: this.glowTex, color: 0xffc46b, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })
    this.sparks = new THREE.Points(geo, mat)
    this.sparks.frustumCulled = false
    this.scene.add(this.sparks)
    this.sparkNext = 0
    for (const e of this.emitters) {
      const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xcfe6ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }))
      flash.scale.setScalar(0.32)
      flash.visible = false
      this.scene.add(flash)
      e.flash = flash
    }
    this.sparkTmp = new THREE.Vector3()
  }

  // --- Публичный интерфейс -------------------------------------------------

  /** Режим тестовых данных: исторические показатели, без «живых» состояний. */
  setDataNodes(nodes) {
    this.simStates = null
    this.buffers.forEach((b) => (b.group.visible = false))
    this.segments.forEach((s) => {
      s.speed = 0
      s.active = false
    })
    for (const n of nodes) {
      const node = this.nodes.get(n.id)
      if (!node) continue
      node.beacon.visible = false
      node.wip.visible = true
      // Нейтральная подсветка участков с данными — фон, не состояние.
      node.pool.material.color.setHex(C.flow)
      node.poolTarget = n.hasData ? 0.12 : 0
      node.pulse = false
      this.#setGhost(node, !n.hasData)
      node.pin.visible = n.severity === 'critical' || n.severity === 'warning'
      node.pin.material.color.setHex(n.severity === 'critical' ? C.pin : C.pinWarn)
      const tag = !n.hasData
        ? '<span class="state nodata">нет данных</span>'
        : n.severity === 'critical'
          ? '<span class="state down">отклонение</span>'
          : n.severity === 'warning'
            ? '<span class="state blocked">внимание</span>'
            : ''
      node.el.innerHTML = `<b>${n.name}</b>${n.caption ? `<small>${n.caption}</small>` : ''}${tag}`
      node.el.dataset.severity = n.severity || ''
      node.el.dataset.state = ''
    }
  }

  /** Режим сценария: состояние цепочки на минуте `frame.t`. */
  setSimFrame(frame, stations, buffers, eta = {}) {
    const modelled = new Set(stations.map((s) => s.id))
    this.simStates = {}
    for (const node of this.nodes.values()) {
      node.pin.visible = false
      node.el.dataset.severity = ''
      const idx = stations.findIndex((s) => s.id === node.id)
      if (idx < 0) {
        this.#setGhost(node, true)
        node.beacon.visible = false
        node.wip.visible = true
        node.poolTarget = 0
        node.pulse = false
        node.el.dataset.state = ''
        setHtml(node.el, `<b>${NAMES[node.id]}</b><span class="state nodata">вне модели</span>`)
        continue
      }
      const state = frame.states[idx] || 'working'
      this.simStates[node.id] = state
      this.#setGhost(node, false)
      node.beacon.visible = true
      // Участок без кузовов стоит пустым.
      node.wip.visible = state !== 'starved'
      for (const [s, lamp] of Object.entries(node.lamps)) {
        const on = s === state
        lamp.material.color.setHex(on ? C[s] : C.unlit)
        lamp.material.emissive.setHex(on ? C[s] : 0x000000)
        lamp.material.emissiveIntensity = on ? 5 : 0
      }
      node.pool.material.color.setHex(C[state])
      node.poolTarget = state === 'working' ? 0.35 : 0.85
      node.pulse = state === 'down'
      node.el.dataset.state = state
      // Прогноз модели: участок пока работает, но скоро встанет из-за соседей.
      const next = eta[node.id]
      const soon = state === 'working' && next && next.state !== 'down' && next.in <= 60
        ? `<small class="eta ${next.state}">⚠ через ${Math.max(1, Math.round(next.in))} мин: ${ETA_LABEL[next.state]}</small>`
        : ''
      setHtml(node.el, `<b>${stations[idx].name}</b><span class="state ${state}">${STATE_LABEL[state]}</span>${soon}`)
    }
    // Поток по сегменту идёт, пока отдающая операция работает. Вход со склада
    // анимируется по первой операции, выход на контроль качества — по последней.
    const first = stations[0]?.id
    for (const seg of this.segments) {
      const source = seg.to === first ? first : seg.from
      seg.active = modelled.has(source)
      seg.speed = seg.active && this.simStates[source] === 'working' ? 1 : 0
    }
    this.buffers.forEach((b, i) => {
      const meta = buffers[i]
      b.group.visible = !!meta
      if (!meta) return
      const level = frame.buffers[i]
      b.units.count = Math.min(level, MAX_UNITS_SHOWN)
      b.levels.forEach((g, l) => (g.visible = level > (l + 1) * 8))
      const full = level >= meta.capacity
      const empty = level === 0
      b.padMat.color.setHex(full ? C.blocked : empty ? C.starved : C.flow)
      b.padMat.opacity = full || empty ? 0.6 : 0.22
      b.unitMat.emissive.setHex(full ? C.blocked : C.flow)
      b.unitMat.emissiveIntensity = full ? 0.12 : 0.04
      const tag = full ? '<span class="state blocked">полный</span>' : empty ? '<span class="state starved">пустой</span>' : ''
      setHtml(b.el, `<span class="cap">накопитель</span><span class="lvl">${level}<i>/${meta.capacity}</i></span>${tag}`)
    })
  }

  select(id) {
    this.selected = id
    const node = this.nodes.get(id)
    if (!node) return this.resetView()
    this.#flyTo(new THREE.Vector3(node.x + 4.2, 8.5, 12.5), new THREE.Vector3(node.x, 0.9, 0.6))
  }

  resetView() {
    this.selected = null
    this.#flyTo(this.home.pos.clone(), this.home.target.clone())
  }

  /** Отступы под панели интерфейса: композиция центрируется в свободной области. */
  setInsets(insets) {
    this.insets = { top: 0, right: 0, bottom: 0, left: 0, ...insets }
    this.#resize()
  }

  setReducedMotion(value) {
    this.reducedMotion = value
    if (value && this.tween) {
      this.camera.position.copy(this.tween.pos)
      this.controls.target.copy(this.tween.target)
      this.tween = null
    }
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect()
    const el = this.renderer.domElement
    el.removeEventListener('pointerdown', this.handlers.down)
    el.removeEventListener('pointerup', this.handlers.up)
    el.removeEventListener('pointermove', this.handlers.move)
    this.controls.dispose()
    const seen = new Set()
    const free = (x) => {
      if (x && !seen.has(x)) {
        seen.add(x)
        x.dispose()
      }
    }
    this.scene.traverse((obj) => {
      free(obj.geometry)
      if (obj.isInstancedMesh) free(obj)
      const mats = Array.isArray(obj.material) ? [...obj.material] : obj.material ? [obj.material] : []
      if (obj.userData.solid) mats.push(obj.userData.solid)
      for (const m of mats) {
        free(m.map)
        free(m)
      }
      if (obj.isCSS2DObject) obj.element.remove()
    })
    this.disposables.forEach(free)
    disposeCarGeometries()
    free(this.envTex)
    this.pmrem.dispose()
    this.gtao.dispose()
    this.bloom.dispose()
    this.composer.dispose()
    this.timer.dispose?.()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    el.remove()
    this.labels.domElement.remove()
  }

  // --- Внутреннее ----------------------------------------------------------

  #setGhost(node, ghost) {
    if (node.ghost === ghost) return
    node.ghost = ghost
    this.aoDirty = true
    node.group.traverse((obj) => {
      if (!obj.isMesh || !obj.userData.kit) return
      if (ghost) {
        obj.userData.solid ??= obj.material
        obj.material = this.#ghostOf(obj.userData.solid)
        obj.castShadow = false
      } else if (obj.userData.solid) {
        obj.material = obj.userData.solid
        obj.castShadow = !obj.material.transparent
      }
    })
    node.el.classList.toggle('ghost', ghost)
  }

  /** Полупрозрачная копия материала для узлов без данных / вне модели. */
  #ghostOf(mat) {
    this.ghostCache ??= new Map()
    if (!this.ghostCache.has(mat)) {
      const g = mat.clone()
      Object.assign(g, { transparent: true, opacity: Math.min(mat.opacity, 0.18), depthWrite: false })
      this.ghostCache.set(mat, g)
      this.disposables.push(g)
    }
    return this.ghostCache.get(mat)
  }

  #setHover(id) {
    this.hovered = id
  }

  #flyTo(pos, target, duration = 0.8) {
    if (this.reducedMotion) {
      this.camera.position.copy(pos)
      this.controls.target.copy(target)
      this.tween = null
      return
    }
    this.tween = { t: 0, duration, fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone(), pos, target }
  }

  #pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects([...this.nodes.values()].map((n) => n.hit), false)
    return hits[0]?.object.parent.userData.nodeId ?? null
  }

  #onPointerUp(e) {
    if (!this.downAt || Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 5) return
    const id = this.#pick(e)
    if (id) this.onSelect?.(id)
  }

  #onPointerMove(e) {
    if (e.buttons) return
    const id = this.#pick(e)
    this.#setHover(id)
    this.renderer.domElement.style.cursor = id ? 'pointer' : 'grab'
  }

  #resize() {
    const { clientWidth: w, clientHeight: h } = this.container
    if (!w || !h) return
    this.renderer.setSize(w, h)
    this.composer.setSize(w, h)
    this.labels.setSize(w, h)
    this.camera.aspect = w / h
    const i = this.insets
    if (i) this.camera.setViewOffset(w, h, (i.right - i.left) / 2, (i.bottom - i.top) / 2, w, h)
    this.camera.updateProjectionMatrix()
    // Дистанция «общего вида» подбирается так, чтобы цепочка влезала в свободную область.
    const freeW = i ? (w - i.left - i.right) / w : 1
    const freeH = i ? (h - i.top - i.bottom) / h : 1
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    const byWidth = SPAN / 2 / (tanV * this.camera.aspect * Math.max(freeW, 0.3))
    const byHeight = 6.5 / (tanV * Math.max(freeH, 0.3))
    const dist = Math.max(byWidth, byHeight) * 1.04
    const atHome = !this.selected && this.camera.position.distanceTo(this.home.pos) < 0.5
    this.home.pos.copy(VIEW_DIR).multiplyScalar(dist).add(this.home.target)
    if (atHome) this.camera.position.copy(this.home.pos)
    if (this.tween && !this.selected) this.tween.pos.copy(this.home.pos)
  }

  #updateTokens(dt, motion) {
    const counts = this.fleet.map(() => ({ biw: 0, painted: 0, complete: 0 }))
    let parts = 0
    this.segments.forEach((seg, si) => {
      if (!seg.active) return
      if (motion) seg.phase = (seg.phase + seg.speed * dt * (0.7 / seg.len)) % 1
      const stage = STAGE[seg.from]
      for (let i = 0; i < TOKENS_PER_SEGMENT; i++) {
        const u = (seg.phase + i / TOKENS_PER_SEGMENT) % 1
        this.tokenPos.set(seg.x0 + 0.8 + u * Math.max(seg.len - 1.6, 0.1), BELT_Y, 0)
        this.tokenMatrix.compose(this.tokenPos, this.tokenQuat, this.tokenScale)
        if (stage === 'parts') {
          this.partsMeshes.forEach((m) => m.setMatrixAt(parts, this.tokenMatrix))
          parts++
          continue
        }
        const id = si * TOKENS_PER_SEGMENT + i
        const vi = id % this.fleet.length
        const k = counts[vi][stage]++
        this.tokenColor.setHex(PAINT[(id * 5 + 1) % PAINT.length])
        for (const m of this.fleet[vi][stage]) {
          m.setMatrixAt(k, this.tokenMatrix)
          if (m.instanceColor) m.setColorAt(k, this.tokenColor)
        }
      }
    })
    this.fleet.forEach((set, vi) => {
      for (const stage of ['biw', 'painted', 'complete']) {
        for (const m of set[stage]) {
          m.count = counts[vi][stage]
          m.instanceMatrix.needsUpdate = true
          if (m.instanceColor) m.instanceColor.needsUpdate = true
        }
      }
    })
    for (const m of this.partsMeshes) {
      m.count = parts
      m.instanceMatrix.needsUpdate = true
    }
  }

  #updateSparks(dt, time, motion) {
    const pos = this.sparkPos
    const vel = this.sparkVel
    const life = this.sparkLife
    const N = life.length
    for (const e of this.emitters) {
      const active = motion && this.simStates?.[e.node] === 'working' && !this.nodes.get(e.node).ghost
      // Сварка идёт импульсами: точка — пауза — следующая точка.
      const on = active && Math.sin(time * 3.1 + e.phase * 4) > 0.35
      e.flash.visible = on && Math.sin(time * 41 + e.phase) > -0.3
      if (!on) continue
      e.tip.getWorldPosition(this.sparkTmp)
      e.flash.position.copy(this.sparkTmp)
      for (let k = 0; k < 4; k++) {
        const i = this.sparkNext
        this.sparkNext = (this.sparkNext + 1) % N
        pos[i * 3] = this.sparkTmp.x
        pos[i * 3 + 1] = this.sparkTmp.y
        pos[i * 3 + 2] = this.sparkTmp.z
        const a = Math.random() * Math.PI * 2
        const s = 0.4 + Math.random() * 1.1
        vel[i * 3] = Math.cos(a) * s
        vel[i * 3 + 1] = Math.random() * 1.2
        vel[i * 3 + 2] = Math.sin(a) * s
        life[i] = 0.35 + Math.random() * 0.35
      }
    }
    for (let i = 0; i < N; i++) {
      if (life[i] <= 0) continue
      life[i] -= dt
      if (life[i] <= 0) {
        pos[i * 3 + 1] = -100
        continue
      }
      vel[i * 3 + 1] -= 4.5 * dt
      pos[i * 3] += vel[i * 3] * dt
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt
      if (pos[i * 3 + 1] < 0.01) {
        // Отскок от пола с потерей скорости.
        pos[i * 3 + 1] = 0.01
        vel[i * 3 + 1] *= -0.3
        vel[i * 3] *= 0.5
        vel[i * 3 + 2] *= 0.5
      }
    }
    this.sparks.geometry.attributes.position.needsUpdate = true
  }

  #loop() {
    this.frame = requestAnimationFrame(() => this.#loop())
    this.timer.update()
    const dt = Math.min(this.timer.getDelta(), 0.1)
    const time = this.timer.getElapsed()
    const motion = !this.reducedMotion

    if (this.tween) {
      this.tween.t = Math.min(1, this.tween.t + dt / this.tween.duration)
      const k = 1 - Math.pow(1 - this.tween.t, 3)
      this.camera.position.lerpVectors(this.tween.fromPos, this.tween.pos, k)
      this.controls.target.lerpVectors(this.tween.fromTarget, this.tween.target, k)
      if (this.tween.t >= 1) this.tween = null
    }

    const ease = (rate) => Math.min(1, dt * rate)
    for (const node of this.nodes.values()) {
      const pulse = node.pulse && motion ? 0.65 + 0.35 * Math.sin(time * 5) : 1
      node.pool.material.opacity += (node.poolTarget * pulse - node.pool.material.opacity) * ease(6)
      const selTarget = this.selected === node.id ? 1 : this.hovered === node.id ? 0.45 : 0
      node.sel.material.opacity += (selTarget - node.sel.material.opacity) * ease(8)
      if (node.pin.visible) {
        if (motion) node.pin.rotation.y += dt * 1.2
        node.pin.position.y = 2.45 + (motion ? Math.sin(time * 2 + node.x) * 0.08 : 0)
      }
      if (node.pulse) node.lamps.down.material.emissiveIntensity = motion ? 3.5 + Math.sin(time * 8) * 2.5 : 5
    }

    this.#updateTokens(dt, motion)
    this.#updateSparks(dt, time, motion)

    // Роботы двигаются, только пока участок работает.
    if (motion) {
      for (const a of this.anim) {
        if (this.simStates?.[a.node] !== 'working') continue
        const t = time * a.speed + a.phase
        const [j1, j2, j3, j5] = a.robot.joints
        const p = a.robot.pose
        j1.rotation.y = p[0] + Math.sin(t) * 0.38
        j2.rotation.z = p[1] + Math.sin(t * 0.8 + 1) * 0.14
        j3.rotation.z = p[2] + Math.sin(t * 1.1 + 2) * 0.2
        j5.rotation.z = p[3] + Math.sin(t * 1.7) * 0.5
      }
    }

    this.controls.update()
    this.composer.render()
    this.labels.render(this.scene, this.camera)
    this.#adaptQuality(dt)
  }

  /**
   * Если кадр стабильно дольше ~28 мс (меньше 35 к/с), снижаем качество по ступеням:
   * без затенения углов → меньше пикселей → без свечения. Обратно не повышаем, чтобы не мигало.
   */
  #adaptQuality(dt) {
    this.perf ??= { sum: 0, n: 0, level: 0, warm: 1.5 }
    const p = this.perf
    if (p.warm > 0) {
      p.warm -= dt // первые секунды — загрузка и влёт камеры, не считаем
      return
    }
    p.sum += dt
    p.n += 1
    if (p.n < 90) return
    const avg = p.sum / p.n
    p.sum = 0
    p.n = 0
    if (avg < 0.028 || p.level >= 3) return
    p.level += 1
    if (p.level === 1) this.gtao.enabled = false
    if (p.level === 2) {
      this.renderer.setPixelRatio(1)
      this.composer.setPixelRatio(1)
      this.#resize()
    }
    if (p.level === 3) this.bloom.enabled = false
    p.warm = 1
  }
}
