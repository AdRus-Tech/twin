// Процедурные кузова для визуализации потока: седан, кроссовер и хэтчбек.
// Обобщённые силуэты без логотипов и пропорций конкретных моделей — это
// обозначения, а не модели конкретного производителя. Строятся в метрах (перед — по +X,
// земля — y=0), затем масштабируются в единицы сцены.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

/** Метров в одной единице сцены. */
export const METER = 1 / 2.9

// Профили кузовов. top — верхняя огибающая сбоку (x, y), остальные значения в метрах.
const TYPES = {
  sedan: {
    L: 4.68, W: 1.82, axle: [1.36, -1.36], wheelR: 0.325, base: 0.2, belt: [0.93, 1.0],
    cabin: [-1.5, 0.98], windshield: [0.98, 0.22], rearGlass: [-0.86, -1.5], roofHalf: 0.66,
    top: [[-2.34, 0.5], [-2.32, 0.78], [-2.22, 0.95], [-1.95, 1.0], [-1.55, 1.02], [-0.86, 1.4], [-0.3, 1.45], [0.22, 1.43], [0.98, 0.99], [1.65, 0.89], [2.18, 0.79], [2.32, 0.66], [2.34, 0.42]],
    clad: 0, bumperY: 0.42,
  },
  crossover: {
    L: 4.5, W: 1.86, axle: [1.33, -1.33], wheelR: 0.36, base: 0.26, belt: [1.02, 1.1],
    cabin: [-1.95, 0.98], windshield: [0.98, 0.3], rearGlass: [-1.78, -2.08], roofHalf: 0.7,
    top: [[-2.25, 0.55], [-2.24, 0.95], [-2.2, 1.1], [-2.08, 1.24], [-1.78, 1.6], [-1.2, 1.66], [0.3, 1.66], [0.98, 1.1], [1.6, 1.0], [2.08, 0.93], [2.22, 0.8], [2.25, 0.5]],
    clad: 0.5, bumperY: 0.5,
  },
  hatch: {
    L: 4.15, W: 1.78, axle: [1.25, -1.27], wheelR: 0.315, base: 0.19, belt: [0.94, 1.02],
    cabin: [-1.72, 0.95], windshield: [0.95, 0.25], rearGlass: [-1.42, -1.9], roofHalf: 0.65,
    top: [[-2.07, 0.5], [-2.06, 0.85], [-2.03, 0.98], [-1.9, 1.1], [-1.42, 1.43], [-0.9, 1.47], [0.25, 1.46], [0.95, 0.97], [1.55, 0.88], [1.95, 0.8], [2.05, 0.66], [2.07, 0.42]],
    clad: 0, bumperY: 0.42,
  },
}
export const CAR_TYPES = Object.keys(TYPES)

/** Заводские цвета кузовов: перламутр, чёрный, серебро, графит, синий, красный. */
export const PAINT = [0xe9ebee, 0x16181b, 0xa9aeb4, 0x4b5259, 0x1d3a6e, 0x8f1820]

const smooth = (a, b, t) => {
  const k = Math.min(1, Math.max(0, (t - a) / (b - a)))
  return k * k * (3 - 2 * k)
}

/** Кусочно-линейная таблица с монотонным сглаживанием между узлами. */
function curve(points) {
  return (x) => {
    if (x <= points[0][0]) return points[0][1]
    for (let i = 1; i < points.length; i++) {
      const [x1, y1] = points[i]
      if (x <= x1) {
        const [x0, y0] = points[i - 1]
        const t = (x - x0) / (x1 - x0)
        // Сглаживаем через соседей (Катмулл–Ром), без выбросов за соседние значения.
        const ym = points[i - 2]?.[1] ?? y0
        const yp = points[i + 1]?.[1] ?? y1
        const m0 = (y1 - ym) / 2
        const m1 = (yp - y0) / 2
        const t2 = t * t
        const t3 = t2 * t
        const y = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * m1
        return Math.min(Math.max(y, Math.min(y0, y1) - 0.03), Math.max(y0, y1) + 0.03)
      }
    }
    return points.at(-1)[1]
  }
}

// Участки сечения (правая половина): номер сегмента нужен для разметки материалов.
const SEG = { bottom: 0, corner: 1, lower: 2, upper: 3, shoulder: 4, side: 5, roofEdge: 6, roof: 7 }
const SEG_STEPS = [3, 3, 4, 4, 3, 5, 4, 4]

/** Точка на сплайне Катмулла–Рома между p1 и p2. */
function cr(p0, p1, p2, p3, t) {
  const t2 = t * t
  const t3 = t2 * t
  const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]
}

function buildShell(spec) {
  const half = spec.L / 2
  const top = curve(spec.top)
  const W2 = spec.W / 2
  const [axleF, axleR] = spec.axle
  const archR = spec.wheelR + 0.05
  const wheelY = spec.wheelR

  const bottomAt = (x) => {
    let y = spec.base + 0.12 * smooth(half - 0.5, half, Math.abs(x))
    for (const ax of [axleF, axleR]) {
      const d = Math.abs(x - ax)
      if (d < archR) y = Math.max(y, wheelY + Math.sqrt(archR * archR - d * d))
    }
    return y
  }
  const widthAt = (x) => {
    const t = Math.min(1, Math.abs(x) / half)
    return W2 * Math.pow(1 - Math.pow(t, 3.4), 1 / 3.4)
  }
  const [c0, c1] = spec.cabin
  const cabinAt = (x) => smooth(c0 - 0.05, c0 + 0.35, x) * (1 - smooth(c1 - 0.3, c1 + 0.05, x))

  // Сечения гуще к носу и корме, где кузов скругляется.
  const NX = 100
  const xs = []
  for (let i = 0; i <= NX; i++) xs.push(-half * Math.cos((Math.PI * i) / NX))

  const ring = (x) => {
    const w = widthAt(x)
    const yt = top(x)
    const yb = Math.min(bottomAt(x), yt - 0.05)
    const cab = cabinAt(x)
    const beltLine = spec.belt[1] + (spec.belt[0] - spec.belt[1]) * ((x + half) / spec.L)
    const yBelt = Math.min(beltLine, yt - 0.03)
    const ySh = Math.max(yb + 0.02, yBelt - 0.07)
    const roofW = Math.min(w * 0.9, spec.roofHalf)
    const wb = w * 0.93
    const gZ = cab * (roofW + 0.04) + (1 - cab) * w * 0.72
    const gY = yt - (0.015 + 0.085 * cab)
    const hZ = cab * roofW * 0.8 + (1 - cab) * w * 0.38
    const pts = [
      [0, yb],
      [w * 0.9, yb],
      [w * 0.985, yb + Math.min(0.1, (ySh - yb) * 0.3)],
      [w, yb + (ySh - yb) * 0.6],
      [w * 0.985, ySh],
      [wb, yBelt],
      [gZ, gY],
      [hZ, yt - 0.004],
      [0, yt],
    ]
    // Сэмплируем сплайн по сегментам: число точек на сегмент фиксировано.
    const out = []
    for (let s = 0; s < pts.length - 1; s++) {
      const p0 = pts[s - 1] ?? [pts[0][0] - (pts[1][0] - pts[0][0]), pts[0][1]]
      const p3 = pts[s + 2] ?? [-pts[s][0], pts[s][1]]
      for (let k = 0; k < SEG_STEPS[s]; k++) {
        const [z, y] = cr(p0, pts[s], pts[s + 1], p3, k / SEG_STEPS[s])
        out.push({ z, y, seg: s })
      }
    }
    out.push({ z: 0, y: yt, seg: SEG.roof })
    return out
  }

  const rings = xs.map((x) => ({ x, pts: ring(x) }))
  const nHalf = rings[0].pts.length
  // Полное кольцо: правая половина + зеркальная левая без дублей на оси.
  const loop = []
  for (let i = 0; i < nHalf; i++) loop.push({ i, side: 1 })
  for (let i = nHalf - 2; i >= 1; i--) loop.push({ i, side: -1 })
  const nLoop = loop.length

  const pos = []
  for (const r of rings) {
    for (const l of loop) {
      const p = r.pts[l.i]
      pos.push(r.x, p.y, p.z * l.side)
    }
  }
  const position = new THREE.Float32BufferAttribute(pos, 3)

  const classify = (x, y, z, seg) => {
        const sideWin = x > c0 + 0.32 && x < spec.windshield[0] - 0.12
    const bPillar = Math.abs(x - (spec.windshield[1] - 0.62)) < 0.07
    if (seg === SEG.side && sideWin) return bPillar ? 'trim' : 'glass'
    if (seg === SEG.side && x > spec.windshield[0] - 0.12 && x < spec.windshield[0] + 0.05 && y > spec.belt[0] + 0.02) return 'trim'
    if (seg >= SEG.roofEdge && x < spec.windshield[0] - 0.02 && x > spec.windshield[1] + 0.02) return 'glass'
    if (seg >= SEG.roofEdge && x < spec.rearGlass[0] - 0.02 && x > spec.rearGlass[1] + 0.03) return 'glass'
    if (seg === SEG.side && spec.clad && x < spec.rearGlass[0] - 0.02 && x > spec.rearGlass[1] + 0.03 && y > spec.belt[1] - 0.02) return 'glass'
    const front = x > half - 0.3
    const rear = x < -half + 0.3
    if (spec.clad && y < spec.base + 0.28 + (front || rear ? 0.04 : 0)) return 'trim'
    if ((front || rear) && y < spec.bumperY - 0.12) return 'trim'
    return 'paint'
  }

  const groups = { paint: [], glass: [], trim: [] }
  for (let r = 0; r < rings.length - 1; r++) {
    for (let k = 0; k < nLoop; k++) {
      const a = r * nLoop + k
      const b = r * nLoop + ((k + 1) % nLoop)
      const c = (r + 1) * nLoop + k
      const d = (r + 1) * nLoop + ((k + 1) % nLoop)
      const cx = (pos[a * 3] + pos[d * 3]) / 2
      const cy = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1] + pos[d * 3 + 1]) / 4
      const cz = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2] + pos[d * 3 + 2]) / 4
      const seg = rings[r].pts[loop[k].i].seg
      const g = groups[classify(cx, cy, cz, seg)]
      g.push(a, c, b, b, c, d)
    }
  }

  const full = new THREE.BufferGeometry()
  full.setAttribute('position', position)
  full.setIndex([].concat(...Object.values(groups)))
  full.computeVertexNormals()
  const normal = full.getAttribute('normal')
  full.dispose()

  const out = {}
  for (const [name, idx] of Object.entries(groups)) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', position)
    g.setAttribute('normal', normal)
    g.setIndex(idx)
    out[name] = g.toNonIndexed()
    g.dispose()
  }
  return { parts: out, widthAt, top, bottomAt }
}

function bare(geo) {
  // Для слияния с кузовом нужны только позиции и нормали.
  const g = geo.index ? geo.toNonIndexed() : geo
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k)
  if (g !== geo) geo.dispose()
  return g
}

function wheel(spec) {
  const R = spec.wheelR
  const tw = 0.23
  // Шина: скруглённый профиль, вращённый вокруг оси.
  const prof = []
  const ri = R * 0.66
  const steps = 10
  prof.push(new THREE.Vector2(ri, -tw / 2))
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / steps
    prof.push(new THREE.Vector2(R - 0.05 + Math.cos(a) * 0.05, Math.sin(a) * (tw / 2)))
  }
  prof.push(new THREE.Vector2(ri, tw / 2))
  const tire = new THREE.LatheGeometry(prof, 28)
  // Диск: обод, ступица и пять спиц.
  const parts = []
  const barrel = new THREE.CylinderGeometry(ri, ri, tw * 0.8, 28, 1, true)
  parts.push(barrel)
  const face = new THREE.RingGeometry(ri * 0.82, ri * 1.0, 28)
  face.rotateX(-Math.PI / 2)
  face.translate(0, tw * 0.4, 0)
  parts.push(face)
  const hub = new THREE.CylinderGeometry(ri * 0.24, ri * 0.28, 0.06, 16)
  hub.translate(0, tw * 0.38, 0)
  parts.push(hub)
  for (let i = 0; i < 5; i++) {
    const s = new THREE.BoxGeometry(0.07, 0.035, ri * 0.66)
    s.translate(0, tw * 0.38, ri * 0.5)
    s.rotateY((i * Math.PI * 2) / 5)
    parts.push(s)
  }
  const rim = mergeGeometries(parts.map(bare))
  // Тормозной диск в глубине — тёмный.
  const disc = new THREE.CylinderGeometry(ri * 0.7, ri * 0.7, 0.03, 20)
  disc.translate(0, -0.02, 0)
  return { tire: bare(tire), rim, disc: bare(disc) }
}

/** Ставит деталь колеса в четыре угла. Ось колеса — Z, наружная сторона диска наружу. */
function atWheels(geo, spec, track) {
  const list = []
  for (const x of spec.axle) {
    for (const side of [1, -1]) {
      const g = geo.clone()
      g.rotateX(side * Math.PI / 2)
      g.translate(x, spec.wheelR, side * track)
      list.push(g)
    }
  }
  return mergeGeometries(list)
}

/**
 * Полоса на носу или корме, повторяющая скругление кузова в плане:
 * фары, фонари и решётка. y0/y1 — функции высоты от x.
 */
function ribbon(spec, dir, z0, z1, y0, y1, out = 0.012) {
  const half = spec.L / 2
  const W = (spec.W / 2) * 0.985
  const xAt = (z) => {
    const t = Math.min(Math.abs(z) / W, 0.999)
    return dir * half * Math.pow(1 - Math.pow(t, 3.4), 1 / 3.4)
  }
  const N = 18
  const pos = []
  const idx = []
  for (let i = 0; i <= N; i++) {
    const z = z0 + ((z1 - z0) * i) / N
    const x = xAt(z)
    // Нормаль кривой в плане — для небольшого выноса полосы наружу.
    const dz = 0.01
    const tx = xAt(z + dz) - xAt(z - dz)
    const len = Math.hypot(tx, 2 * dz)
    const nx = (2 * dz / len) * dir
    const nz = (-tx / len) * dir
    const ox = x + Math.abs(nx) * dir * out
    const oz = z + nz * out * (dir > 0 ? 1 : 1)
    pos.push(ox, y0(x), oz, ox, y1(x), oz)
    if (i < N) {
      const a = i * 2
      if (dir > 0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
      else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g.toNonIndexed()
}

function buildCar(name) {
  const spec = TYPES[name]
  const { parts, widthAt, top } = buildShell(spec)
  const track = spec.W / 2 - 0.15
  const w = wheel(spec)
  const tires = atWheels(w.tire, spec, track)
  const rims = atWheels(w.rim, spec, track)
  const discs = atWheels(w.disc, spec, track)
  Object.values(w).forEach((g) => g.dispose())

  // Зеркала, колёсные ниши и днище.
  const mx = spec.windshield[0] - 0.12
  const mirrors = []
  for (const side of [1, -1]) {
    const m = new RoundedBoxGeometry(0.2, 0.13, 0.17, 2, 0.04)
    const beltY = spec.belt[0] + 0.06
    m.translate(mx, beltY, side * (widthAt(mx) * 0.93 + 0.07))
    mirrors.push(bare(m))
  }
  const under = []
  for (const x of spec.axle) {
    const well = new THREE.BoxGeometry(spec.wheelR * 2.25, 0.5, spec.W - 0.36)
    well.translate(x, spec.wheelR + 0.08, 0)
    under.push(bare(well))
  }
  const floor = new THREE.BoxGeometry(spec.L * 0.86, 0.06, spec.W * 0.84)
  floor.translate(0, spec.base + 0.05, 0)
  under.push(bare(floor))

  // Фары под кромкой капота, фонари — сплошной полосой по корме, решётка внизу.
  const W2 = spec.W / 2
  const lights = []
  for (const s of [1, -1]) lights.push(ribbon(spec, 1, s * W2 * 0.5, s * W2 * 0.9, (x) => top(x) - 0.13, (x) => top(x) - 0.045))
  const tailY = spec.bumperY + (spec.clad ? 0.5 : 0.4)
  const tail = ribbon(spec, -1, -W2 * 0.9, W2 * 0.9, () => tailY, () => tailY + 0.08)
  const grille = ribbon(spec, 1, -W2 * 0.48, W2 * 0.48, () => spec.bumperY - 0.03, () => spec.bumperY + 0.15, 0.008)
  const lower = ribbon(spec, 1, -W2 * 0.62, W2 * 0.62, () => spec.bumperY - 0.2, () => spec.bumperY - 0.1, 0.006)
  parts.light = mergeGeometries(lights)
  parts.tail = tail
  parts.grille = mergeGeometries([grille, lower])
  lights.forEach((g) => g.dispose())
  grille.dispose()
  lower.dispose()

  const shell = mergeGeometries([parts.paint, parts.trim])
  const complete = {
    paint: mergeGeometries([parts.paint, ...mirrors]),
    glass: parts.glass,
    trim: mergeGeometries([parts.trim, ...under]),
    light: parts.light,
    tail: parts.tail,
    grille: parts.grille,
    tire: tires,
    rim: rims,
    disc: discs,
  }
  mirrors.forEach((g) => g.dispose())
  under.forEach((g) => g.dispose())
  parts.paint.dispose()
  const scale = (g) => g.scale(METER, METER, METER)
  scale(shell)
  Object.values(complete).forEach(scale)
  return { shell, complete, length: spec.L * METER, height: Math.max(...spec.top.map((p) => p[1])) * METER }
}

/** Материалы автомобиля. Цвет краски задаётся per-instance (белый × цвет экземпляра). */
export function createCarMaterials() {
  return {
    paint: new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.45, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.03 }),
    // Кузов после окраски без стёкол — видно салон, поэтому двусторонний.
    paintOpen: new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.45, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.03, side: THREE.DoubleSide }),
    // Сварной кузов: голая сталь.
    steel: new THREE.MeshStandardMaterial({ color: 0xb9c0c8, metalness: 0.7, roughness: 0.34, side: THREE.DoubleSide, envMapIntensity: 0.8 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x0a0e13, metalness: 0.1, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.0, envMapIntensity: 1.6 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.62, metalness: 0.05 }),
    light: new THREE.MeshStandardMaterial({ color: 0xdfe7f0, emissive: 0xeaf4ff, emissiveIntensity: 1.2, roughness: 0.1, metalness: 0.4, side: THREE.DoubleSide }),
    tail: new THREE.MeshStandardMaterial({ color: 0x6b0710, emissive: 0xff1a2a, emissiveIntensity: 0.8, roughness: 0.15, side: THREE.DoubleSide }),
    grille: new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.35, metalness: 0.6, side: THREE.DoubleSide }),
    tire: new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.88 }),
    rim: new THREE.MeshStandardMaterial({ color: 0xc9ced4, metalness: 1, roughness: 0.22 }),
    disc: new THREE.MeshStandardMaterial({ color: 0x55585c, metalness: 0.9, roughness: 0.5 }),
  }
}

let cache = null
/** Геометрии всех типов кузовов (строятся один раз и переиспользуются). */
export function carGeometries() {
  cache ??= Object.fromEntries(CAR_TYPES.map((n) => [n, buildCar(n)]))
  return cache
}

export function disposeCarGeometries() {
  if (!cache) return
  for (const c of Object.values(cache)) {
    c.shell.dispose()
    Object.values(c.complete).forEach((g) => g.dispose())
  }
  cache = null
}

/** Готовая машина как обычная группа (для склада и участков): общий кэш геометрий. */
export function carMesh(type, mats, paintMat, stage = 'complete') {
  const geo = carGeometries()[type]
  const g = new THREE.Group()
  const add = (geom, mat) => {
    const m = new THREE.Mesh(geom, mat)
    m.castShadow = true
    m.receiveShadow = true
    g.add(m)
  }
  if (stage === 'biw') add(geo.shell, mats.steel)
  else if (stage === 'painted') add(geo.shell, paintMat)
  else {
    for (const [k, gm] of Object.entries(geo.complete)) add(gm, k === 'paint' ? paintMat : mats[k])
  }
  return g
}

/** Детали на входе: поддон со стопкой штампованных панелей. */
export function partsGeometry() {
  const s = METER
  const pallet = []
  for (const z of [-0.45, 0, 0.45]) {
    const b = new THREE.BoxGeometry(1.2, 0.1, 0.12)
    b.translate(0, 0.05, z)
    pallet.push(b)
  }
  const deck = new THREE.BoxGeometry(1.2, 0.03, 1.0)
  deck.translate(0, 0.115, 0)
  pallet.push(deck)
  const panels = []
  for (let i = 0; i < 7; i++) {
    const p = new RoundedBoxGeometry(1.05, 0.05, 0.85, 1, 0.02)
    p.translate(0, 0.16 + i * 0.065, 0)
    panels.push(bare(p))
  }
  const wood = mergeGeometries(pallet.map(bare))
  const metal = mergeGeometries(panels)
  wood.scale(s, s, s)
  metal.scale(s, s, s)
  return { wood, metal }
}
