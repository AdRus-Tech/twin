// Процедурное оборудование цеха: роботы, конвейеры, ограждения, камера окраски,
// тоннель контроля, стеллажи, люди. Всё строится в метрах; участок целиком
// масштабируется в единицы сцены (METER). Это условные обозначения участков,
// а не планировка конкретного предприятия.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { METER, carMesh } from './vehicles.js'

/** Высота ленты роликового конвейера, м. */
export const CONVEYOR_H = 0.62

// --- Текстуры ----------------------------------------------------------------

function canvasTex(w, h, draw, { repeat = true, srgb = true } = {}) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d'), w, h)
  const t = new THREE.CanvasTexture(c)
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

function rng(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
}

/** Пол цеха: эпоксидное покрытие по бетону, плиты 6×6 м со швами. */
export function floorTextures() {
  const rnd = rng(11)
  const map = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#b9bec3'
    g.fillRect(0, 0, w, h)
    for (let i = 0; i < 9000; i++) {
      const v = 165 + Math.floor(rnd() * 45)
      g.fillStyle = `rgba(${v},${v + 3},${v + 6},${0.08 + rnd() * 0.12})`
      const r = 1 + rnd() * 3
      g.fillRect(rnd() * w, rnd() * h, r, r)
    }
    // Мягкие пятна — следы износа покрытия.
    for (let i = 0; i < 16; i++) {
      const x = rnd() * w
      const y = rnd() * h
      const r = 30 + rnd() * 90
      const gr = g.createRadialGradient(x, y, 0, x, y, r)
      gr.addColorStop(0, `rgba(120,128,136,${0.05 + rnd() * 0.06})`)
      gr.addColorStop(1, 'rgba(120,128,136,0)')
      g.fillStyle = gr
      g.fillRect(x - r, y - r, r * 2, r * 2)
    }
    g.strokeStyle = 'rgba(70,76,82,.55)'
    g.lineWidth = 2
    g.strokeRect(1, 1, w - 2, h - 2)
  })
  const rough = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#7a7a7a'
    g.fillRect(0, 0, w, h)
    for (let i = 0; i < 40; i++) {
      const x = rnd() * w
      const y = rnd() * h
      const r = 15 + rnd() * 50
      const v = 70 + Math.floor(rnd() * 90)
      const gr = g.createRadialGradient(x, y, 0, x, y, r)
      gr.addColorStop(0, `rgba(${v},${v},${v},.6)`)
      gr.addColorStop(1, `rgba(${v},${v},${v},0)`)
      g.fillStyle = gr
      g.fillRect(x - r, y - r, r * 2, r * 2)
    }
  }, { srgb: false })
  return { map, rough }
}

function meshTexture() {
  // Сетка ограждения: светлые прутья, прозрачные ячейки (alphaMap).
  return canvasTex(64, 64, (g, w, h) => {
    g.fillStyle = '#000'
    g.fillRect(0, 0, w, h)
    g.fillStyle = '#fff'
    for (let i = 0; i < w; i += 16) {
      g.fillRect(i, 0, 3, h)
      g.fillRect(0, i, w, 3)
    }
  }, { srgb: false })
}

function slatTexture() {
  return canvasTex(64, 64, (g, w, h) => {
    g.fillStyle = '#4d535a'
    g.fillRect(0, 0, w, h)
    g.fillStyle = '#2b2f34'
    for (let i = 0; i < w; i += 16) g.fillRect(i, 0, 2, h)
    g.fillStyle = 'rgba(255,255,255,.05)'
    for (let i = 4; i < w; i += 16) g.fillRect(i, 0, 6, h)
  })
}

function gratingTexture() {
  return canvasTex(64, 64, (g, w, h) => {
    g.fillStyle = '#3b4148'
    g.fillRect(0, 0, w, h)
    g.fillStyle = '#23272c'
    for (let i = 0; i < w; i += 8) g.fillRect(i, 0, 3, h)
    for (let i = 0; i < h; i += 32) g.fillRect(0, i, w, 2)
  })
}

function panelTexture() {
  // Сэндвич-панели стен: вертикальные рёбра.
  return canvasTex(128, 64, (g, w, h) => {
    g.fillStyle = '#d9dde1'
    g.fillRect(0, 0, w, h)
    for (let i = 0; i < w; i += 16) {
      g.fillStyle = 'rgba(0,0,0,.08)'
      g.fillRect(i, 0, 3, h)
      g.fillStyle = 'rgba(255,255,255,.4)'
      g.fillRect(i + 3, 0, 2, h)
    }
  })
}

function screenTexture(accent = '#3ee8a9') {
  return canvasTex(128, 80, (g, w, h) => {
    g.fillStyle = '#0b1622'
    g.fillRect(0, 0, w, h)
    g.fillStyle = accent
    g.fillRect(8, 8, 50, 6)
    g.fillStyle = 'rgba(255,255,255,.55)'
    for (let i = 0; i < 4; i++) g.fillRect(8, 22 + i * 10, 30 + ((i * 37) % 60), 3)
    g.strokeStyle = accent
    g.lineWidth = 2
    g.beginPath()
    for (let x = 0; x <= 50; x += 5) g.lineTo(70 + x, 60 - Math.abs(Math.sin(x / 9)) * 30)
    g.stroke()
  }, { repeat: false })
}

// --- Материалы -----------------------------------------------------------------

export function createFactoryMaterials() {
  const fence = meshTexture()
  fence.repeat.set(8, 6)
  const slats = slatTexture()
  const grating = gratingTexture()
  const panel = panelTexture()
  const std = (p) => new THREE.MeshStandardMaterial(p)
  const m = {
    robot: new THREE.MeshPhysicalMaterial({ color: 0xf06a12, roughness: 0.42, metalness: 0.1, clearcoat: 0.5, clearcoatRoughness: 0.25 }),
    robotWhite: new THREE.MeshPhysicalMaterial({ color: 0xeef0f2, roughness: 0.45, metalness: 0.05, clearcoat: 0.4, clearcoatRoughness: 0.3 }),
    joint: std({ color: 0x2a2e33, roughness: 0.5, metalness: 0.6 }),
    dark: std({ color: 0x30353b, roughness: 0.6, metalness: 0.35 }),
    steel: std({ color: 0xa4acb5, roughness: 0.32, metalness: 0.9 }),
    frame: std({ color: 0x5b6672, roughness: 0.5, metalness: 0.55 }),
    yellow: std({ color: 0xf0b40a, roughness: 0.5, metalness: 0.2 }),
    blue: std({ color: 0x2c58a6, roughness: 0.45, metalness: 0.3 }),
    orange: std({ color: 0xe0601a, roughness: 0.5, metalness: 0.25 }),
    copper: std({ color: 0xb87333, roughness: 0.35, metalness: 0.9 }),
    rubber: std({ color: 0x17191c, roughness: 0.9 }),
    wood: std({ color: 0xa7814f, roughness: 0.85 }),
    cardboard: std({ color: 0xb48c5a, roughness: 0.9 }),
    wrap: new THREE.MeshPhysicalMaterial({ color: 0xd8dde3, roughness: 0.25, metalness: 0, clearcoat: 0.6, transparent: true, opacity: 0.85 }),
    binBlue: std({ color: 0x2462b0, roughness: 0.55 }),
    binYellow: std({ color: 0xe6b422, roughness: 0.55 }),
    binGrey: std({ color: 0x8b939c, roughness: 0.6 }),
    fence: std({ color: 0x3a4048, roughness: 0.5, metalness: 0.5, alphaMap: fence, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    slats: std({ color: 0xffffff, map: slats, roughness: 0.55, metalness: 0.3 }),
    grating: std({ color: 0xffffff, map: grating, roughness: 0.6, metalness: 0.4 }),
    wall: std({ color: 0xffffff, map: panel, roughness: 0.7, metalness: 0.05 }),
    boothWall: std({ color: 0xf1f3f5, roughness: 0.5, metalness: 0.05 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0xcfe3ef, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 2 }),
    led: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf4f8ff, emissiveIntensity: 2.6, roughness: 0.3 }),
    ledWarm: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff1d6, emissiveIntensity: 1.6, roughness: 0.3 }),
    window: new THREE.MeshStandardMaterial({ color: 0xbcd3e6, emissive: 0xd7e8f6, emissiveIntensity: 0.65, roughness: 0.1, metalness: 0.3 }),
    screen: new THREE.MeshBasicMaterial({ map: screenTexture() }),
    screenWarn: new THREE.MeshBasicMaterial({ map: screenTexture('#ffb224') }),
    suit: std({ color: 0x2b3a52, roughness: 0.85 }),
    vest: std({ color: 0xd4f53c, roughness: 0.7, emissive: 0x2a3300, emissiveIntensity: 0.3 }),
    skin: std({ color: 0xc99272, roughness: 0.7 }),
    helmet: std({ color: 0xf4f5f6, roughness: 0.35, metalness: 0.05 }),
    line: std({ color: 0xf2c230, roughness: 0.6 }),
    white: std({ color: 0xf2f2ee, roughness: 0.6 }),
    green: std({ color: 0x4f8f68, roughness: 0.55 }),
  }
  m.textures = [fence, slats, grating, panel, m.screen.map, m.screenWarn.map]
  return m
}

// --- Сборка геометрии ----------------------------------------------------------

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _s = new THREE.Vector3()
const _p = new THREE.Vector3()

/** Копит статичную геометрию по материалам и сливает в один меш на материал. */
export class Batch {
  constructor() {
    this.parts = new Map()
  }

  add(geo, mat, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) {
    _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz))
    const g = geo.index ? geo.toNonIndexed() : geo.clone()
    geo.dispose()
    g.applyMatrix4(_m)
    if (!this.parts.has(mat)) this.parts.set(mat, [])
    this.parts.get(mat).push(g)
    return this
  }

  box(w, h, d, mat, o = {}) {
    return this.add(new THREE.BoxGeometry(w, h, d), mat, { ...o, y: (o.y ?? 0) + (o.base ? h / 2 : 0) })
  }

  rbox(w, h, d, r, mat, o = {}) {
    return this.add(new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2) * 0.999), mat, o)
  }

  cyl(r, h, mat, o = {}, seg = 16) {
    return this.add(new THREE.CylinderGeometry(r, r, h, seg), mat, o)
  }

  build() {
    const group = new THREE.Group()
    for (const [mat, list] of this.parts) {
      const keepUv = !!(mat.map || mat.alphaMap)
      for (const g of list) {
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && !(keepUv && k === 'uv')) g.deleteAttribute(k)
      }
      const merged = mergeGeometries(list)
      list.forEach((g) => g.dispose())
      const mesh = new THREE.Mesh(merged, mat)
      mesh.castShadow = !mat.transparent
      mesh.receiveShadow = true
      group.add(mesh)
    }
    this.parts.clear()
    return group
  }
}

function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat)
  m.position.set(x, y, z)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

// --- Роботы --------------------------------------------------------------------

/**
 * Шестиосевой промышленный робот на пьедестале. Рука вытянута по +X.
 * Возвращает группу и суставы для анимации.
 */
export function robot(M, { white = false, tool = 'weld', riser = 0.55 } = {}) {
  const paint = white ? M.robotWhite : M.robot
  const root = new THREE.Group()
  const b = new Batch()
  b.box(1.0, riser, 1.0, M.dark, { y: riser / 2 })
  b.box(1.1, 0.04, 1.1, M.yellow, { y: 0.02 })
  b.cyl(0.36, 0.28, M.joint, { y: riser + 0.14 }, 24)
  root.add(b.build())

  const j1 = new THREE.Group()
  j1.position.y = riser + 0.28
  root.add(j1)
  const t = new Batch()
  t.cyl(0.34, 0.24, paint, { y: 0.12 }, 24)
  t.rbox(0.6, 0.52, 0.56, 0.08, paint, { x: -0.04, y: 0.44 })
  t.cyl(0.12, 0.34, M.joint, { x: -0.3, y: 0.46, z: 0.26, rx: Math.PI / 2 })
  t.box(0.2, 0.28, 0.22, M.dark, { x: -0.42, y: 0.36 })
  j1.add(t.build())

  const j2 = new THREE.Group()
  j2.position.set(0.12, 0.56, 0)
  j1.add(j2)
  const l = new Batch()
  l.cyl(0.21, 0.5, M.joint, { rx: Math.PI / 2 }, 24)
  l.rbox(0.28, 1.15, 0.3, 0.07, paint, { y: 0.58 })
  l.cyl(0.05, 0.9, M.rubber, { x: -0.14, y: 0.55, z: 0.17 })
  // Уравновешивающий цилиндр.
  l.cyl(0.07, 0.75, M.steel, { x: -0.24, y: 0.4, z: -0.2, rz: 0.2 })
  j2.add(l.build())

  const j3 = new THREE.Group()
  j3.position.set(0, 1.15, 0)
  j2.add(j3)
  const f = new Batch()
  f.cyl(0.17, 0.44, M.joint, { rx: Math.PI / 2 }, 24)
  f.rbox(0.5, 0.36, 0.36, 0.08, paint, { x: -0.04 })
  f.rbox(1.0, 0.2, 0.22, 0.06, paint, { x: 0.6, y: 0.04 })
  f.cyl(0.11, 0.18, M.joint, { x: -0.32, rz: Math.PI / 2 })
  j3.add(f.build())

  const j5 = new THREE.Group()
  j5.position.set(1.12, 0.04, 0)
  j3.add(j5)
  const w = new Batch()
  w.cyl(0.09, 0.16, M.joint, { rx: Math.PI / 2 })
  w.cyl(0.07, 0.14, M.steel, { x: 0.1, rz: Math.PI / 2 })
  j5.add(w.build())

  const tip = new THREE.Object3D()
  const tb = new Batch()
  if (tool === 'weld') {
    // Сварочные клещи: трансформатор и С-образная скоба с электродами.
    tb.box(0.22, 0.2, 0.18, M.dark, { x: 0.27 })
    tb.add(new THREE.TorusGeometry(0.2, 0.03, 8, 20, Math.PI * 1.25), M.steel, { x: 0.52, y: -0.06, rz: -Math.PI * 0.1 })
    tb.cyl(0.018, 0.12, M.copper, { x: 0.72, y: -0.02 })
    tip.position.set(0.72, -0.08, 0)
  } else if (tool === 'paint') {
    // Ротационный распылитель.
    tb.cyl(0.06, 0.3, M.steel, { x: 0.3, rz: Math.PI / 2 })
    tb.add(new THREE.CylinderGeometry(0.08, 0.03, 0.08, 16), M.robotWhite, { x: 0.48, rz: Math.PI / 2 })
    tip.position.set(0.55, 0, 0)
  } else {
    // Захват с присосками.
    tb.box(0.08, 0.08, 0.08, M.dark, { x: 0.22 })
    tb.box(0.06, 0.5, 0.5, M.frame, { x: 0.29 })
    for (const [y, z] of [[0.18, 0.18], [-0.18, 0.18], [0.18, -0.18], [-0.18, -0.18]]) tb.cyl(0.05, 0.06, M.rubber, { x: 0.34, y, z, rz: Math.PI / 2 })
    tip.position.set(0.38, 0, 0)
  }
  j5.add(tb.build())
  j5.add(tip)

  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true
      o.receiveShadow = true
    }
  })
  const joints = [j1, j2, j3, j5]
  const pose = [0, -0.35, -0.25, -0.2]
  joints.forEach((j, i) => (i === 0 ? (j.rotation.y = pose[i]) : (j.rotation.z = pose[i])))
  return { root, joints, pose, tip }
}

// --- Конвейеры, ограждения, стеллажи ------------------------------------------------

/** Роликовый конвейер длиной len вдоль X, центр в начале координат. */
export function rollerConveyor(b, M, len, { x = 0, width = 1.25, h = CONVEYOR_H } = {}) {
  for (const z of [-width / 2, width / 2]) {
    b.box(len, 0.14, 0.09, M.frame, { x, y: h - 0.1, z })
    b.box(len, 0.03, 0.12, M.yellow, { x, y: h - 0.015, z: z + Math.sign(z) * 0.03 })
  }
  const legs = Math.max(2, Math.round(len / 1.6) + 1)
  for (let i = 0; i < legs; i++) {
    const lx = x - len / 2 + 0.1 + ((len - 0.2) * i) / (legs - 1)
    for (const z of [-width / 2, width / 2]) b.box(0.08, h - 0.16, 0.08, M.dark, { x: lx, y: (h - 0.16) / 2, z })
    b.box(0.06, 0.06, width, M.dark, { x: lx, y: 0.2 })
  }
  const n = Math.floor(len / 0.32)
  for (let i = 0; i < n; i++) {
    b.cyl(0.045, width - 0.08, M.steel, { x: x - len / 2 + 0.16 + i * 0.32, y: h - 0.07, rx: Math.PI / 2 }, 10)
  }
}

/** Сетчатое ограждение по ломаной: стойки и панели. */
export function fence(b, M, points, h = 2.0) {
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, z0] = points[i]
    const [x1, z1] = points[i + 1]
    const len = Math.hypot(x1 - x0, z1 - z0)
    const ang = Math.atan2(-(z1 - z0), x1 - x0)
    const n = Math.max(1, Math.round(len / 1.4))
    for (let k = 0; k < n; k++) {
      const t0 = k / n
      const t1 = (k + 1) / n
      const cx = x0 + (x1 - x0) * ((t0 + t1) / 2)
      const cz = z0 + (z1 - z0) * ((t0 + t1) / 2)
      const pl = len / n - 0.08
      const g = new THREE.PlaneGeometry(pl, h - 0.25)
      const uv = g.attributes.uv
      for (let u = 0; u < uv.count; u++) uv.setXY(u, uv.getX(u) * pl * 0.7, uv.getY(u) * (h - 0.25) * 0.7)
      b.add(g, M.fence, { x: cx, y: 0.12 + (h - 0.25) / 2, z: cz, ry: ang })
      b.box(pl, 0.04, 0.04, M.yellow, { x: cx, y: h - 0.08, z: cz, ry: ang })
    }
    for (let k = 0; k <= n; k++) {
      const px = x0 + ((x1 - x0) * k) / n
      const pz = z0 + ((z1 - z0) * k) / n
      b.box(0.07, h, 0.07, M.yellow, { x: px, y: h / 2, z: pz })
      b.box(0.18, 0.02, 0.18, M.dark, { x: px, y: 0.01, z: pz })
    }
  }
}

/** Паллетный стеллаж: bays пролётов по 2,7 м, levels ярусов. Возвращает места под грузы. */
export function palletRack(b, M, { x = 0, z = 0, bays = 3, levels = 3, depth = 1.1, levelH = 1.6 } = {}) {
  const bw = 2.7
  const width = bays * bw
  const h = levels * levelH + 0.3
  const slots = []
  for (let i = 0; i <= bays; i++) {
    const ux = x - width / 2 + i * bw
    for (const dz of [-depth / 2, depth / 2]) b.box(0.08, h, 0.08, M.blue, { x: ux, y: h / 2, z: z + dz })
    for (let k = 0; k < levels * 2; k++) b.box(0.03, 0.03, depth, M.blue, { x: ux, y: 0.3 + k * (h / (levels * 2)), z })
  }
  for (let l = 0; l < levels; l++) {
    const y = 0.15 + l * levelH
    for (const dz of [-depth / 2, depth / 2]) b.box(width, 0.11, 0.06, M.orange, { x, y, z: z + dz })
    for (let i = 0; i < bays; i++) slots.push({ x: x - width / 2 + bw / 2 + i * bw, y: y + 0.06, z })
  }
  return slots
}

/** Груз на паллете: коробки, упакованная стопка или ящики с деталями. */
export function palletLoad(b, M, { x, y, z, kind = 0, rnd = Math.random }) {
  for (const dx of [-0.65, 0.65]) {
    b.box(1.2, 0.03, 1.0, M.wood, { x: x + dx, y: y + 0.13, z })
    for (const pz of [-0.42, 0, 0.42]) b.box(1.2, 0.11, 0.1, M.wood, { x: x + dx, y: y + 0.055, z: z + pz })
    const top = y + 0.145
    if (kind === 0) {
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) {
          const hh = 0.32 + rnd() * 0.12
          b.box(0.56, hh, 0.48, M.cardboard, { x: x + dx - 0.29 + i * 0.58, y: top + hh / 2, z: z - 0.25 + j * 0.5 })
          if (rnd() > 0.4) b.box(0.56, hh * 0.9, 0.48, M.cardboard, { x: x + dx - 0.29 + i * 0.58, y: top + hh + hh * 0.45, z: z - 0.25 + j * 0.5 })
        }
      }
    } else if (kind === 1) {
      const hh = 0.7 + rnd() * 0.35
      b.rbox(1.15, hh, 0.95, 0.04, M.wrap, { x: x + dx, y: top + hh / 2, z })
    } else {
      b.box(1.15, 0.55, 0.95, M.binGrey, { x: x + dx, y: top + 0.275, z })
      for (let i = 0; i < 6; i++) b.box(1.0, 0.02, 0.8, M.steel, { x: x + dx, y: top + 0.56 + i * 0.03, z })
    }
  }
}

// --- Люди ------------------------------------------------------------------------

/** Фигура оператора в спецодежде (≈1,75 м). pose: 'stand' | 'work' | 'tablet'. */
export function worker(b, M, { x = 0, z = 0, ry = 0, pose = 'stand' } = {}) {
  const c = Math.cos(ry)
  const s = Math.sin(ry)
  // Локальные (u — вперёд, v — вбок) → мировые x/z.
  const at = (u, v) => ({ x: x + u * c + v * s, z: z - u * s + v * c })
  const cap = (r, len, mat, u, y, v, rx = 0, rz = 0) => b.add(new THREE.CapsuleGeometry(r, len, 4, 10), mat, { ...at(u, v), y, ry, rx, rz })
  for (const v of [-0.1, 0.1]) {
    cap(0.075, 0.68, M.suit, 0, 0.42, v)
    b.rbox(0.26, 0.09, 0.12, 0.03, M.rubber, { ...at(0.05, v), y: 0.05, ry })
  }
  b.rbox(0.42, 0.58, 0.25, 0.09, M.suit, { ...at(0, 0), y: 1.1, ry })
  b.rbox(0.44, 0.42, 0.27, 0.08, M.vest, { ...at(0, 0), y: 1.16, ry })
  b.cyl(0.06, 0.1, M.skin, { ...at(0, 0), y: 1.44 })
  b.add(new THREE.SphereGeometry(0.105, 16, 12), M.skin, { ...at(0.01, 0), y: 1.56 })
  b.add(new THREE.SphereGeometry(0.125, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.helmet, { ...at(0, 0), y: 1.6 })
  b.cyl(0.13, 0.015, M.helmet, { ...at(0.02, 0), y: 1.6 })
  const reach = pose !== 'stand'
  for (const v of [-0.26, 0.26]) {
    if (reach) cap(0.055, 0.32, M.suit, 0.08, 1.12, v * 0.92)
    else cap(0.055, 0.52, M.suit, 0, 1.03, v * 0.95)
  }
  if (reach) {
    // Предплечья вперёд — оператор работает руками или держит планшет.
    for (const v of [-0.2, 0.2]) {
      b.rbox(0.36, 0.1, 0.1, 0.045, M.suit, { ...at(0.34, v), y: 0.9, ry })
      b.add(new THREE.SphereGeometry(0.05, 10, 8), M.skin, { ...at(0.54, v), y: 0.9 })
    }
    if (pose === 'tablet') b.box(0.22, 0.02, 0.3, M.dark, { ...at(0.5, 0), y: 0.94, ry })
  }
}

// --- Участки ---------------------------------------------------------------------

/** Сварка: роботизированная ячейка за ограждением, сварной кузов на конвейере. */
export function weldingCell(M, mats, { len }) {
  const g = new THREE.Group()
  const b = new Batch()
  rollerConveyor(b, M, len)
  const fx = len / 2 - 0.2
  fence(b, M, [[-fx, -1.1], [-fx, -3.6], [fx, -3.6], [fx, -1.1]])
  fence(b, M, [[-fx, 1.1], [-fx, 3.6], [fx, 3.6], [fx, 1.1]])
  // Шкафы управления роботами за ограждением.
  for (let i = 0; i < 4; i++) {
    const cx = -fx + 1.2 + i * 1.1
    b.box(0.9, 1.9, 0.6, M.boothWall, { x: cx, y: 0.95, z: -4.3 })
    b.box(0.3, 0.2, 0.02, M.screen, { x: cx, y: 1.45, z: -3.99 })
    b.box(0.92, 0.08, 0.62, M.dark, { x: cx, y: 1.92, z: -4.3 })
  }
  // Портал сварочного кондуктора над кузовом.
  for (const x of [-1.5, 1.5]) {
    for (const z of [-1.0, 1.0]) b.box(0.18, 3.0, 0.18, M.blue, { x, y: 1.5, z })
    b.box(0.22, 0.25, 2.2, M.blue, { x, y: 3.0 })
  }
  b.box(3.2, 0.2, 0.2, M.blue, { y: 3.0, z: -1.0 })
  b.box(3.2, 0.2, 0.2, M.blue, { y: 3.0, z: 1.0 })
  // Кабель-каналы на полу.
  b.box(len - 1, 0.04, 0.25, M.yellow, { y: 0.02, z: -2.85 })
  g.add(b.build())

  const robots = []
  for (const [x, z] of [[-2.6, -2.3], [2.4, -2.3], [-2.0, 2.3], [2.8, 2.3]]) {
    const r = robot(M, { tool: 'weld' })
    r.root.position.set(x, 0, z)
    r.root.rotation.y = z < 0 ? -Math.PI / 2 : Math.PI / 2
    g.add(r.root)
    robots.push(r)
  }
  return { group: g, robots, wipY: CONVEYOR_H, wip: 'biw' }
}

/** Окраска: остеклённая камера с белыми окрасочными роботами. */
export function paintBooth(M, mats, { len }) {
  const g = new THREE.Group()
  const b = new Batch()
  const L = len - 0.6
  const D = 6.4
  const H = 4.4
  rollerConveyor(b, M, len + 0.6)
  b.add(new THREE.PlaneGeometry(L, D), M.grating, { y: 0.03, rx: -Math.PI / 2 })
  // Задняя стена — сплошная, передняя — стекло на цоколе.
  b.box(L, H, 0.14, M.boothWall, { y: H / 2, z: -D / 2 })
  b.box(L, 0.9, 0.14, M.boothWall, { y: 0.45, z: D / 2 })
  b.add(new THREE.PlaneGeometry(L, H - 1.0), M.glass, { y: 0.9 + (H - 1.0) / 2, z: D / 2 })
  const mull = Math.round(L / 1.5)
  for (let i = 0; i <= mull; i++) b.box(0.08, H - 0.9, 0.1, M.frame, { x: -L / 2 + (L * i) / mull, y: 0.9 + (H - 0.9) / 2, z: D / 2 })
  b.box(L, 0.12, 0.16, M.frame, { y: H, z: D / 2 })
  // Торцы с проёмами для кузова.
  for (const sx of [-1, 1]) {
    const x = (sx * L) / 2
    const ow = 2.6
    const oh = 2.5
    const side = (D - ow) / 2
    for (const sz of [-1, 1]) b.box(0.14, H, side, M.boothWall, { x, y: H / 2, z: sz * (ow / 2 + side / 2) })
    b.box(0.14, H - oh, ow, M.boothWall, { x, y: oh + (H - oh) / 2 })
    b.box(0.2, 0.12, ow + 0.2, M.yellow, { x, y: oh, z: 0 })
  }
  // Потолок: каркас, фильтровальные панели и световые линии.
  for (let i = 0; i <= 4; i++) b.box(L, 0.1, 0.12, M.frame, { y: H, z: -D / 2 + (D * i) / 4 })
  b.add(new THREE.PlaneGeometry(L, D), M.glass, { y: H, rx: -Math.PI / 2 })
  for (const z of [-2.0, 2.0]) b.box(L - 0.6, 0.06, 0.22, M.led, { y: H + 0.02, z })
  // Приточная установка за камерой.
  b.rbox(L * 0.8, 2.6, 1.8, 0.1, M.boothWall, { y: 1.3, z: -D / 2 - 1.25 })
  for (const x of [-2.2, 0, 2.2]) b.cyl(0.35, 2.2, M.steel, { x, y: 3.0, z: -D / 2 - 0.8 }, 20)
  b.box(L * 0.7, 0.7, 0.9, M.steel, { y: 4.1, z: -D / 2 - 0.6 })
  b.box(0.8, 0.5, 0.02, M.screen, { x: L / 2 - 1.2, y: 1.8, z: -D / 2 - 0.34 })
  g.add(b.build())

  const robots = []
  for (const [x, z] of [[-1.6, -2.2], [1.6, -2.2], [-1.0, 2.2], [2.0, 2.2]]) {
    const r = robot(M, { white: true, tool: 'paint', riser: 0.8 })
    r.root.position.set(x, 0, z)
    r.root.rotation.y = z < 0 ? -Math.PI / 2 : Math.PI / 2
    g.add(r.root)
    robots.push(r)
  }
  return { group: g, robots, wipY: CONVEYOR_H, wip: 'painted' }
}

/** Сборка: пластинчатый конвейер, порталы с инструментом, стеллажи с деталями, операторы. */
export function assemblyLine(M, mats, { len }) {
  const g = new THREE.Group()
  const b = new Batch()
  const plat = 0.32
  const w = 3.0
  const slats = new THREE.BoxGeometry(len, plat, w)
  const uv = slats.attributes.uv
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len * 1.5, uv.getY(i))
  b.add(slats, M.slats, { y: plat / 2 })
  for (const z of [-w / 2 - 0.05, w / 2 + 0.05]) b.box(len, plat + 0.02, 0.1, M.yellow, { y: (plat + 0.02) / 2, z })
  // Порталы: стойки, балки, подвесной инструмент и светильники.
  const n = Math.round(len / 3.2)
  for (let i = 0; i <= n; i++) {
    const x = -len / 2 + 0.3 + ((len - 0.6) * i) / n
    for (const z of [-2.5, 2.5]) b.box(0.2, 3.8, 0.2, M.yellow, { x, y: 1.9, z })
    b.box(0.22, 0.24, 5.2, M.yellow, { x, y: 3.8 })
  }
  for (const z of [-1.0, 1.0]) b.box(len - 0.4, 0.14, 0.14, M.dark, { y: 3.64, z })
  for (const z of [-0.6, 0.6]) b.box(len - 1.0, 0.05, 0.16, M.led, { y: 3.55, z })
  for (let i = 0; i < n; i++) {
    const x = -len / 2 + 1.9 + i * 3.2
    for (const z of [-1.0, 1.0]) {
      b.cyl(0.008, 1.2, M.dark, { x, y: 2.95, z }, 4)
      b.cyl(0.06, 0.22, M.dark, { x, y: 2.3, z })
      b.box(0.08, 0.16, 0.08, M.orange, { x, y: 2.12, z })
    }
  }
  // Стеллажи подачи деталей с ящиками.
  const rnd = rng(5)
  for (let i = 0; i < 5; i++) {
    const x = -len / 2 + 1.6 + i * ((len - 3.2) / 4)
    for (const z of [-3.2, 3.2]) {
      for (const sx of [-0.6, 0.6]) b.box(0.05, 1.6, 0.05, M.frame, { x: x + sx, y: 0.8, z: z - 0.3 })
      for (const sx of [-0.6, 0.6]) b.box(0.05, 1.2, 0.05, M.frame, { x: x + sx, y: 0.6, z: z + 0.3 })
      for (let l = 0; l < 3; l++) {
        const y = 0.35 + l * 0.42
        b.box(1.25, 0.03, 0.7, M.steel, { x, y, z, rx: (z < 0 ? -1 : 1) * 0.18 })
        for (let k = 0; k < 3; k++) b.box(0.36, 0.2, 0.55, rnd() > 0.5 ? M.binBlue : M.binYellow, { x: x - 0.4 + k * 0.4, y: y + 0.12, z, rx: (z < 0 ? -1 : 1) * 0.18 })
      }
    }
  }
  // Операторы по обе стороны конвейера.
  const people = [[-5.4, 1.95, Math.PI / 2], [-1.6, -1.95, -Math.PI / 2], [2.4, 1.95, Math.PI / 2], [6.0, -1.95, -Math.PI / 2], [-3.4, -2.0, -Math.PI / 2]]
  for (const [x, z, ry] of people) {
    b.box(1.4, 0.06, 0.9, M.dark, { x, y: 0.03, z })
    worker(b, M, { x, z, ry: ry + Math.PI, pose: 'work' })
  }
  // Тележки с инструментом.
  for (const [x, z] of [[-6.8, 2.6], [4.2, -2.6]]) {
    b.box(0.9, 0.8, 0.5, M.orange, { x, y: 0.55, z })
    for (const dx of [-0.35, 0.35]) for (const dz of [-0.18, 0.18]) b.cyl(0.06, 0.04, M.rubber, { x: x + dx, y: 0.06, z: z + dz, rx: Math.PI / 2 })
  }
  g.add(b.build())

  const robots = []
  for (const [x, z] of [[len / 2 - 2.0, -2.0], [-len / 2 + 1.6, 2.0]]) {
    const r = robot(M, { tool: 'grip', riser: 0.4 })
    r.root.position.set(x, 0, z)
    r.root.rotation.y = z < 0 ? -Math.PI / 2 : Math.PI / 2
    g.add(r.root)
    robots.push(r)
  }
  return { group: g, robots, wipY: plat, wip: 'assembly' }
}

/** Контроль качества: световой тоннель из арок со светодиодными линиями. */
export function inspectionTunnel(M, mats, { len }) {
  const g = new THREE.Group()
  const b = new Batch()
  rollerConveyor(b, M, len + 0.6, { h: 0.18, width: 2.2 })
  const tl = 5.2
  const iw = 4.0
  const ih = 3.0
  const arches = 7
  for (let i = 0; i < arches; i++) {
    const x = -tl / 2 + (tl * i) / (arches - 1)
    for (const z of [-iw / 2, iw / 2]) b.box(0.12, ih, 0.16, M.dark, { x, y: ih / 2, z })
    b.box(0.12, 0.16, iw + 0.16, M.dark, { x, y: ih })
  }
  // Светодиодные линии: по стенам — продольные, по потолку — поперечные.
  for (const z of [-iw / 2 + 0.1, iw / 2 - 0.1]) {
    for (const y of [0.7, 1.3, 1.9, 2.5]) b.box(tl, 0.045, 0.045, M.led, { y, z })
  }
  for (let i = 0; i < 12; i++) b.box(0.06, 0.04, iw - 0.2, M.led, { x: -tl / 2 + 0.2 + i * ((tl - 0.4) / 11), y: ih - 0.12 })
  // Тёмная обшивка задней стенки; сверху тоннель открыт — видны световые арки.
  b.box(tl, ih, 0.06, M.dark, { y: ih / 2, z: -iw / 2 - 0.12 })
  for (const z of [-iw / 2, iw / 2]) b.box(tl + 0.12, 0.1, 0.16, M.dark, { y: ih, z })
  // Светлый пол тоннеля под машиной.
  b.box(tl, 0.02, iw - 0.3, M.boothWall, { y: 0.01 })
  // Пост контролёра: стойка с монитором и оператор с планшетом.
  b.box(0.08, 1.4, 0.08, M.frame, { x: 3.3, y: 0.7, z: 2.6 })
  b.box(0.9, 0.55, 0.06, M.dark, { x: 3.3, y: 1.55, z: 2.6, ry: -0.4 })
  b.box(0.82, 0.47, 0.01, M.screen, { x: 3.31, y: 1.55, z: 2.64, ry: -0.4 })
  b.box(0.5, 0.06, 0.5, M.dark, { x: 3.3, y: 0.03, z: 2.6 })
  worker(b, M, { x: 2.6, z: 2.5, ry: Math.PI / 2 + 0.5, pose: 'tablet' })
  g.add(b.build())
  return { group: g, robots: [], wipY: 0.18, wip: 'complete' }
}

/** Склад комплектующих: паллетные стеллажи, погрузчик, поддоны у линии. */
export function partsStore(M) {
  const g = new THREE.Group()
  const b = new Batch()
  const rnd = rng(3)
  const slots = [
    ...palletRack(b, M, { x: 0, z: -3.2, bays: 3, levels: 3 }),
    ...palletRack(b, M, { x: -1.35, z: 2.6, bays: 2, levels: 2 }),
  ]
  slots.forEach((s, i) => {
    if (rnd() > 0.15) palletLoad(b, M, { ...s, kind: i % 3, rnd })
  })
  palletLoad(b, M, { x: 2.6, y: 0, z: 0.4, kind: 2, rnd })
  palletLoad(b, M, { x: 2.6, y: 0, z: 2.0, kind: 0, rnd })
  forklift(b, M, { x: 0.3, z: -0.4, ry: 0.4 })
  worker(b, M, { x: -2.6, z: 0.2, ry: 0.3, pose: 'tablet' })
  g.add(b.build())
  return { group: g, robots: [] }
}

function forklift(b, M, { x, z, ry }) {
  const c = Math.cos(ry)
  const s = Math.sin(ry)
  const at = (u, v) => ({ x: x + u * c + v * s, z: z - u * s + v * c, ry })
  b.rbox(1.9, 0.75, 1.1, 0.12, M.yellow, { ...at(0, 0), y: 0.6 })
  b.rbox(0.7, 0.6, 1.05, 0.1, M.dark, { ...at(-0.75, 0), y: 0.85 })
  for (const v of [-0.48, 0.48]) {
    b.box(0.06, 1.25, 0.06, M.dark, { ...at(0.55, v), y: 1.6 })
    b.box(0.06, 1.25, 0.06, M.dark, { ...at(-0.45, v), y: 1.6 })
  }
  b.box(1.1, 0.05, 1.05, M.dark, { ...at(0.05, 0), y: 2.24 })
  b.box(0.12, 2.3, 0.7, M.dark, { ...at(1.02, 0), y: 1.2 })
  for (const v of [-0.25, 0.25]) b.box(1.1, 0.05, 0.12, M.dark, { ...at(1.6, v), y: 0.12 })
  b.box(0.3, 0.06, 0.6, M.dark, { ...at(0, 0), y: 1.0 })
  for (const u of [0.6, -0.6]) {
    for (const v of [-0.5, 0.5]) b.cyl(0.27, 0.22, M.rubber, { ...at(u, v), y: 0.27, rx: Math.PI / 2 }, 16)
  }
}

/** Площадка готовой продукции: размеченные места и машины. */
export function finishedLot(M, mats, paints) {
  const g = new THREE.Group()
  const b = new Batch()
  const cars = []
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 3; i++) {
      const x = -2.9 + i * 2.9
      const z = row === 0 ? -2.9 : 2.9
      for (const dx of [-1.4, 1.4]) b.box(0.08, 0.01, 5.0, M.white, { x: x + dx, y: 0.006, z })
      cars.push({ x, z, ry: row === 0 ? Math.PI / 2 : -Math.PI / 2, i: row * 3 + i })
    }
  }
  b.box(8.8, 0.01, 0.08, M.white, { y: 0.006, z: -5.4 })
  b.box(8.8, 0.01, 0.08, M.white, { y: 0.006, z: 5.4 })
  g.add(b.build())
  const types = ['crossover', 'sedan', 'hatch', 'crossover', 'crossover', 'sedan']
  for (const c of cars) {
    if (c.i === 4) continue // одно место свободно
    const car = carMesh(types[c.i], mats, paints[c.i % paints.length])
    car.scale.setScalar(1 / METER) // геометрия машин уже в единицах сцены, а группа участка — в метрах
    car.position.set(c.x, 0, c.z)
    car.rotation.y = c.ry
    g.add(car)
  }
  return { group: g, robots: [] }
}

/** Стены цеха за линией: сэндвич-панели, ленточное остекление, колонны, вентиляция. */
export function hallBackdrop(M, { from, to, z }) {
  const b = new Batch()
  const len = to - from
  const H = 9.5
  const wall = new THREE.PlaneGeometry(len, H)
  const uv = wall.attributes.uv
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len / 4, uv.getY(i) * H / 4)
  b.add(wall, M.wall, { x: (from + to) / 2, y: H / 2, z })
  b.box(len, 1.6, 0.05, M.window, { x: (from + to) / 2, y: 7.2, z: z + 0.05 })
  b.box(len, 1.0, 0.2, M.dark, { x: (from + to) / 2, y: 0.5, z: z + 0.1 })
  for (let x = from; x <= to + 0.01; x += 6) {
    // Двутавровые колонны.
    b.box(0.5, H, 0.06, M.frame, { x, y: H / 2, z: z + 0.5 })
    b.box(0.06, H, 0.6, M.frame, { x, y: H / 2, z: z + 0.5 })
    b.box(0.5, H, 0.06, M.frame, { x, y: H / 2, z: z + 0.8 })
  }
  for (let x = from + 3; x < to; x += 6) {
    b.box(0.9, 0.12, 0.5, M.ledWarm, { x, y: 6.0, z: z + 1.4 })
    b.box(0.04, 1.5, 0.04, M.dark, { x, y: 6.8, z: z + 1.4 })
  }
  // Воздуховод вдоль стены.
  b.cyl(0.45, len, M.steel, { x: (from + to) / 2, y: 8.2, z: z + 1.0, rz: Math.PI / 2 }, 20)
  // Шкафы и щиты у стены.
  for (let x = from + 5; x < to - 2; x += 13) {
    b.box(2.4, 2.0, 0.6, M.boothWall, { x, y: 1.0, z: z + 0.5 })
    b.box(0.6, 0.35, 0.02, M.screenWarn, { x: x - 0.6, y: 1.5, z: z + 0.81 })
  }
  return b.build()
}
