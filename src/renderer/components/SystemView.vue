<template>
  <div class="system-view">
    <h1>{{ system?.Name }}</h1>
    <div class="system-content">
      <!-- Your system view content will go here -->
    </div>
    <div id="pixi-container" style="width: 100vw; height: calc(100vh - 64px); position: absolute; top: 64px; left: 0" />
  </div>
</template>

<script>
import * as PIXI from 'pixi.js'
import { Viewport } from 'pixi-viewport'
import { mapGetters } from 'vuex'
import { starName, systemBodyName } from '~/utilities/aurora'

PIXI.settings.ROUND_PIXELS = true

const bodyTypes = {
  1: 'Asteroid',
  2: 'Terrestrial Planet',
  3: 'Dwarf Planet',
  4: 'Gas Giant',
  7: 'Small Moon',
  8: 'Large Moon',
  10: 'Large Terrestrial Moon',
  14: 'Comet',
}

const unitsToPx = (u) => u * 150
const toNum = (v, fallback = 0) => {
  if (v === null || v === undefined) return fallback
  if (typeof v === 'string') {
    const s = v.trim().toUpperCase()
    if (s === '' || s === 'NULL' || s === 'NAN') return fallback
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
const toBool = (v) => {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return ['1', 'TRUE', 'YES'].includes(v.trim().toUpperCase())
  return false
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

const DEG2RAD = Math.PI / 180
const AU_KM = 149597870.7

// --- Angle convention helper ---
// Many DBs store Bearing as a compass bearing: 0° = North (up), 90° = East, clockwise positive.
// PIXI math here uses 0° = +X (right), angle increasing clockwise (because y is down).
// To fix the ~90° rotation mismatch, convert compass → screen with: θ = (B - 90)°.
const BEARING_MODE = 'compass' // 'compass' | 'screenCW' | 'mathCCW'
const angleFromBearing = (bearingDeg, mode = BEARING_MODE) => {
  switch (mode) {
    case 'compass': // 0=N, +CW  → screen θ=0 at +X, +CW
      return (bearingDeg - 90) * DEG2RAD
    case 'mathCCW': // 0=+X, +CCW → convert to screen by flipping sign
      return -bearingDeg * DEG2RAD
    case 'screenCW': // 0=+X, +CW  → already matches PIXI y-down trig
    default:
      return bearingDeg * DEG2RAD
  }
}

// --- Kepler solver: Mean anomaly (M) → True anomaly (ν) ---
const trueAnomalyFromMean = (M, e, tol = 1e-8, maxIter = 50) => {
  // normalize M to [-π, π]
  M = ((M + Math.PI) % (2 * Math.PI)) - Math.PI
  // initial guess
  let E = e < 0.8 ? M : M > 0 ? Math.PI : -Math.PI
  for (let i = 0; i < maxIter; i++) {
    const f = E - e * Math.sin(E) - M
    const fp = 1 - e * Math.cos(E)
    const dE = -f / fp
    E += dE
    if (Math.abs(dE) < tol) break
  }
  const cosE = Math.cos(E),
    sinE = Math.sin(E)
  const s = Math.sqrt(1 - e * e)
  const nu = Math.atan2(s * sinE, cosE - e)
  return nu // radians, relative to periapsis
}

// Heuristic: for comets/asteroids or very eccentric or Trojan entries, DB Bearing is likely MEAN anomaly.
const shouldTreatBearingAsMeanAnomaly = (bodyLike, e) => {
  const typeId = toNum(bodyLike.BodyTypeID, -1)
  const bodyClass = toNum(bodyLike.BodyClass, -1)
  const trojan = toNum(bodyLike.TrojanAsteroid, 0)
  return e >= 0.3 || typeId === 14 || bodyClass >= 100 || trojan !== 0
}

// Star pixel radius from luminosity (L≈1 → readable, caps to avoid galaxy-sized suns)
const starPixelRadius = (star, sizeOpts = {}) => {
  const {
    sizeMode = 'luminosity', // "luminosity" | "fixed"
    fixedPx = 8,
    minPx = 4,
    maxPx = 22,
    scale = 5, // used in luminosity mode
  } = sizeOpts
  if (sizeMode === 'fixed') return clamp(fixedPx, minPx, maxPx)
  const L = Math.max(0, toNum(star.Luminosity, 1)) // assume L in L☉
  // Rough but nice-looking: Rpx ∝ sqrt(L)
  return clamp(minPx + Math.sqrt(L) * scale, minPx, maxPx)
}

// Optional color per component (A/B/C…), purely cosmetic
const starColorForComponent = (component) => {
  const pal = {
    1: 0xfff2a6, // A
    2: 0xffc88b, // B
    3: 0xaad0ff, // C
    4: 0xffffff, // D
    5: 0xffaea6, // E
  }
  return pal[component] ?? 0xffffff
}

const drawStar = (radiusPx, color = 0xffffff, outline = 0x000000) => {
  const g = new PIXI.Graphics()
  g.beginFill(color, 1)
  g.lineStyle(1, outline, 0.5)
  g.drawCircle(0, 0, radiusPx)
  g.endFill()
  return g
}

const drawOrbitLocal = (parentContainer, position, bodyLike, style = { color: 0x8aa1ff, alpha: 0.55, width: 2 }, opts = { orbitLine: true, keepLabelUpright: true, usePolyline: false, segments: 256 }) => {
  const orbitContainer = new PIXI.Container()
  orbitContainer.position.set(toNum(position.x), toNum(position.y))

  const a = Math.max(0, toNum(bodyLike.OrbitalDistance, 0))
  let e = clamp(toNum(bodyLike.Eccentricity, 0), 0, 0.999)
  if ((!e || e <= 0) && Number.isFinite(toNum(bodyLike.DistanceToOrbitCentre))) {
    const cWorld = Math.max(0, toNum(bodyLike.DistanceToOrbitCentre, 0))
    if (a > 0) e = clamp(cWorld / a, 0, 0.999)
  }
  const b = a * Math.sqrt(1 - e * e)
  const c = a * e
  const phi = toNum(bodyLike.EccentricityDirection, 0) * DEG2RAD

  const ax = unitsToPx(a)
  const by = unitsToPx(b)
  const cx = unitsToPx(c)

  orbitContainer.rotation = phi

  if (opts.orbitLine) {
    const g = new PIXI.Graphics()
    g.lineStyle(style.width ?? 1, style.color ?? 0x8aa1ff, style.alpha ?? 0.55)
    if (!opts.usePolyline) {
      g.drawEllipse(cx, 0, ax, by) // ellipse centered at (c,0); focus at (0,0)
    } else {
      const segs = Math.max(32, opts.segments || 256)
      for (let i = 0; i <= segs; i++) {
        const t = (i / segs) * Math.PI * 2
        const x = cx + ax * Math.cos(t)
        const y = by * Math.sin(t)
        if (i === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
    }
    orbitContainer.addChild(g)
  }

  // Marker (body position)
  const marker = new PIXI.Graphics()
  marker.beginFill(0xffffff, 1).lineStyle(1, 0x000000, 0.6).drawCircle(0, 0, 3).endFill()

  // Prefer exact DB coordinates when available (Xcor/Ycor in km, relative to parent focus)
  const xkm = toNum(bodyLike.Xcor, NaN)
  const ykm = toNum(bodyLike.Ycor, NaN)
  if (Number.isFinite(xkm) && Number.isFinite(ykm) && (xkm !== 0 || ykm !== 0)) {
    const xWorldPx = unitsToPx(xkm / AU_KM)
    const yWorldPx = unitsToPx(ykm / AU_KM)
    const cosφ = Math.cos(phi),
      sinφ = Math.sin(phi)
    // orbitContainer rotates by φ → convert world vector back to local before rotation
    const localX = xWorldPx * cosφ + yWorldPx * sinφ
    const localY = -xWorldPx * sinφ + yWorldPx * cosφ
    marker.position.set(localX, localY)
  } else {
    // Use orbital elements (bearing interpreted in screen space)
    const bearingDegRaw = toNum(bodyLike.Bearing, 0)
    const bearingDeg = ((bearingDegRaw % 360) + 360) % 360
    const nu = angleFromBearing(bearingDeg, BEARING_MODE)
    const r = a > 0 ? (a * (1 - e * e)) / (1 + e * Math.cos(nu)) : 0
    const rPx = unitsToPx(r)
    marker.position.set(rPx * Math.cos(nu), rPx * Math.sin(nu))
  }
  orbitContainer.addChild(marker)

  // Optional label (stays upright)
  if (opts.nameText) {
    const textStyle = new PIXI.TextStyle({ fill: 0xffffff, fontSize: 10 })
    const label = new PIXI.Text(String(opts.nameText), textStyle)
    label.anchor.set(0.5, 1)
    label.position.set(marker.x, marker.y - 8)
    if (opts.keepLabelUpright) label.rotation = -orbitContainer.rotation
    orbitContainer.addChild(label)
  }

  parentContainer.addChild(orbitContainer)
  return { orbitContainer, marker }
}

// const drawSystem = (stage, system, opts = {}) => {
//   const { origin = { x: 0, y: 0 }, orbitStyle = { color: 0x6aa7ff, alpha: 0.45, width: 1 }, starSize = { sizeMode: 'luminosity', minPx: 4, maxPx: 22, scale: 5 } } = opts

//   const stars = system?.System?.Stars

//   const root = new PIXI.Container()
//   root.position.set(toNum(origin.x), toNum(origin.y))
//   stage.addChild(root)

//   // Build index by Component and by StarID
//   const byComponent = new Map()
//   const byStarID = new Map()
//   stars.forEach((s) => {
//     byComponent.set(toNum(s.Component, 1), s)
//   })

//   // Sort by hierarchy depth so parents get drawn first
//   const compToParent = (s) => toNum(s.OrbitingComponent, 0)
//   const depthOf = (s, seen = new Set()) => {
//     const parentC = compToParent(s)
//     if (!parentC) return 0
//     if (seen.has(s)) return 0
//     seen.add(s)
//     const parent = byComponent.get(parentC)
//     return parent ? 1 + depthOf(parent, seen) : 0
//   }
//   const ordered = [...stars].sort((a, b) => depthOf(a) - depthOf(b))

//   // Draw
//   const drawnByComponent = new Map()
//   ordered.forEach((star, index) => {
//     const comp = toNum(star.Component, 1)
//     const parentComp = toNum(star.OrbitingComponent, 0)

//     // Choose parent container & local focus point
//     let parentContainer = root
//     let parentLocal = { x: 0, y: 0 }
//     if (parentComp) {
//       const parentDrawn = drawnByComponent.get(parentComp)
//       if (parentDrawn) {
//         parentContainer = parentDrawn.orbitContainer
//         parentLocal = parentDrawn.marker.position // orbit about the parent's current position
//       }
//     }

//     // Draw the star's ORBIT path and "marker" (its current orbital position)
//     const { orbitContainer, marker } = drawOrbitLocal(
//       parentContainer,
//       parentLocal,
//       {
//         OrbitalDistance: star.OrbitalDistance,
//         Eccentricity: star.Eccentricity,
//         EccentricityDirection: star.EccentricityDirection,
//         Bearing: star.Bearing,
//         DistanceToParent: star.DistanceToParent,
//         DistanceToOrbitCentre: star.DistanceToOrbitCentre,
//         Xcor: star.Xcor,
//         Ycor: star.Ycor,
//       },
//       orbitStyle,
//       { keepLabelUpright: true }
//     )

//     // Draw the star itself at the marker
//     const radiusPx = starPixelRadius(star, starSize)
//     const color = starColorForComponent(comp)
//     const sprite = drawStar(radiusPx, color)
//     sprite.position.copyFrom(marker.position)
//     orbitContainer.addChild(sprite)

//     // Label for star (bigger, always shown)
//     const starLabelText = starName(index, system)
//     const starLabelStyle = new PIXI.TextStyle({ fill: 0xffffff, fontSize: 12, fontWeight: 'bold', dropShadow: true, dropShadowDistance: 1, dropShadowBlur: 0, dropShadowAlpha: 0.6 })
//     const starLabel = new PIXI.Text(starLabelText, starLabelStyle)
//     starLabel.anchor.set(0.5, 1)
//     starLabel.position.set(sprite.position.x, sprite.position.y - (radiusPx + 6))
//     starLabel.rotation = -orbitContainer.rotation
//     orbitContainer.addChild(starLabel)

//     // Save references
//     drawnByComponent.set(comp, { orbitContainer, marker, sprite, star })
//     byStarID.set(toNum(star.StarID), { orbitContainer, marker, sprite, star })
//   })

//   return { root, byStarID: Object.fromEntries(byStarID), byComponent: Object.fromEntries(drawnByComponent) }
// }

const drawSystem = (stage, system, opts = {}) => {
  const { origin = { x: 0, y: 0 }, orbitStyle = { color: 0x6aa7ff, alpha: 0.45, width: 1 }, starSize = { sizeMode: 'luminosity', minPx: 4, maxPx: 22, scale: 5 } } = opts

  const stars = system?.System?.Stars || []

  const root = new PIXI.Container()
  root.position.set(toNum(origin.x), toNum(origin.y))
  stage.addChild(root)

  // Build index by Component and by StarID
  const byComponent = new Map()
  const byStarID = new Map()
  stars.forEach((s) => {
    byComponent.set(toNum(s.Component, 1), s)
  })

  // Sort by hierarchy depth so parents get drawn first
  const compToParent = (s) => toNum(s.OrbitingComponent, 0)
  const depthOf = (s, seen = new Set()) => {
    const parentC = compToParent(s)
    if (!parentC) return 0
    if (seen.has(s)) return 0
    seen.add(s)
    const parent = byComponent.get(parentC)
    return parent ? 1 + depthOf(parent, seen) : 0
  }
  const ordered = [...stars].sort((a, b) => depthOf(a) - depthOf(b))

  // Draw
  const drawnByComponent = new Map()
  ordered.forEach((star, index) => {
    const comp = toNum(star.Component, 1)
    const parentComp = toNum(star.OrbitingComponent, 0)

    // Choose parent container & local focus point
    let parentContainer = root
    let parentLocal = { x: 0, y: 0 }
    let parentWorldXkm, parentWorldYkm
    if (parentComp) {
      const parentDrawn = drawnByComponent.get(parentComp)
      if (parentDrawn) {
        parentContainer = parentDrawn.orbitContainer
        parentLocal = parentDrawn.marker.position // orbit about the parent's current position
        parentWorldXkm = toNum(parentDrawn.star.Xcor, NaN)
        parentWorldYkm = toNum(parentDrawn.star.Ycor, NaN)
      }
    }

    // Draw the star's ORBIT path and marker (its current orbital position)
    const { orbitContainer, marker } = drawOrbitLocal(
      parentContainer,
      parentLocal,
      {
        OrbitalDistance: star.OrbitalDistance,
        Eccentricity: star.Eccentricity,
        EccentricityDirection: star.EccentricityDirection,
        Bearing: star.Bearing,
        DistanceToParent: star.DistanceToParent,
        DistanceToOrbitCentre: star.DistanceToOrbitCentre,
        Xcor: star.Xcor,
        Ycor: star.Ycor,
      },
      orbitStyle,
      { orbitLine: true, keepLabelUpright: true, parentWorldXkm, parentWorldYkm }
    )

    // Draw the star itself at the marker
    const radiusPx = starPixelRadius(star, starSize)
    const color = starColorForComponent(comp)
    const sprite = drawStar(radiusPx, color)
    sprite.position.copyFrom(marker.position)
    orbitContainer.addChild(sprite)

    // Label for star (bigger, always shown)
    const labelText = starName(index, system)
    const starLabelStyle = new PIXI.TextStyle({ fill: 0xffffff, fontSize: 12, fontWeight: 'bold', dropShadow: true, dropShadowDistance: 1, dropShadowBlur: 0, dropShadowAlpha: 0.6 })
    const starLabel = new PIXI.Text(labelText, starLabelStyle)
    starLabel.anchor.set(0.5, 1)
    starLabel.position.set(sprite.position.x, sprite.position.y - (radiusPx + 6))
    starLabel.rotation = -orbitContainer.rotation
    orbitContainer.addChild(starLabel)

    drawnByComponent.set(comp, { orbitContainer, marker, sprite, star })
    byStarID.set(toNum(star.StarID), { orbitContainer, marker, sprite, star })
  })

  return { root, byStarID: Object.fromEntries(byStarID), byComponent: Object.fromEntries(drawnByComponent) }
}

// function drawBodyAround(parentContainer, parentLocalPos, systemBody, style = { color: 0x8aa1ff, alpha: 0.55, width: 1 }) {
//   const name = systemBody.Name && systemBody.Name !== 'NULL' ? systemBody.Name : null
//   const { orbitContainer, marker } = drawOrbitLocal(parentContainer, parentLocalPos, systemBody, style, {
//     orbitLine: [2, 4].includes(systemBody.BodyTypeID),
//     keepLabelUpright: true,
//     nameText: name,
//   })
//   return { orbitContainer, marker }
// }

// function drawBodiesForSystem(rootContainer, bodies, starsResult, style = { color: 0x8aa1ff, alpha: 0.55, width: 1 }) {
//   const out = []
//   for (const body of bodies) {
//     const sid = toNum(body.StarID, NaN)
//     const starRef = starsResult.byStarID[String(sid)] || starsResult.byStarID[sid]
//     if (!starRef) {
//       // Fallback: if no star mapping, attach to root at system origin
//       out.push(drawBodyAround(rootContainer, { x: 0, y: 0 }, body, style))
//       continue
//     }
//     // Attach body orbit to the star's orbit container, centered at the star's *current* position
//     out.push(drawBodyAround(starRef.orbitContainer, starRef.marker.position, body, style))
//   }
//   return out
// }

/**
 * Convenience to draw all bodies given star placements.
 * Expects each body row to have a StarID (which it does in your schema).
 * @param {*} rootContainer Where to add (e.g., the system root)
 * @param {*} bodies Array of systemBody rows
 * @param {*} starsResult Result of drawMultiStarSystem (so we know where stars are)
 * @param {*} style orbit style for bodies
 */
function drawBodyAround(parentContainer, parentLocalPos, body, style = { color: 0x8aa1ff, alpha: 0.55, width: 1 }, parentWorldXkm, parentWorldYkm) {
  return drawOrbitLocal(parentContainer, parentLocalPos, body, style, {
    orbitLine: [2, 3, 4].includes(body.BodyTypeID), // gas giants and terrestrial planets get orbits
    keepLabelUpright: true,
    nameText: systemBodyName(body),
    parentWorldXkm,
    parentWorldYkm,
  })
}

function drawBodiesForSystem(rootContainer, bodies, starsResult, style = { color: 0x8aa1ff, alpha: 0.55, width: 1 }) {
  const out = []
  for (const body of bodies) {
    const sid = toNum(body.StarID, NaN)
    const starRef = starsResult.byStarID[String(sid)] || starsResult.byStarID[sid]
    if (!starRef) {
      // Fallback: if no star mapping, attach to root at system origin
      out.push(drawBodyAround(rootContainer, { x: 0, y: 0 }, body, style))
      continue
    }
    // Attach body orbit to the star's orbit container, centered at the star's *current* position
    out.push(drawBodyAround(starRef.orbitContainer, starRef.marker.position, body, style, starRef.star && toNum(starRef.star.Xcor, NaN), starRef.star && toNum(starRef.star.Ycor, NaN)))
  }
  return out
}

export default {
  name: 'SystemView',
  props: {
    systemId: {
      type: [String, Number],
      required: true,
    },
  },
  data() {
    return {
      // Your component data here
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),
  },
  mounted() {},
  beforeDestroy() {
    if (this.pixi) {
      console.log('Destroying PIXI application??')
      this.pixi.destroy(true, true)
      this.pixi = null
    }
  },
  watch: {
    systemBodies(newVal, oldVal) {
      console.log('systemBodies changed:', newVal)
      this.initPixi()
    },
  },
  methods: {
    initPixi() {
      if (this.pixi) {
        this.pixi.destroy(true, true)
        this.pixi = null
      }

      console.log('SystemView mounted', this.$props)

      this.pixi = new PIXI.Application({
        width: window.innerWidth,
        height: window.innerHeight - 64, // Adjust for toolbar height
        backgroundColor: 0x0a0a23,
        zIndex: 0,
      })

      const pixiContainer = document.getElementById('pixi-container')
      if (pixiContainer) {
        pixiContainer.appendChild(this.pixi.view)
      } else {
        console.warn('No pixi-container found... Aborting PIXI initialization.')

        return
      }

      const viewport = new Viewport({
        screenWidth: window.innerWidth,
        screenHeight: window.innerHeight - 64, // Adjust for toolbar height
        worldWidth: 1000,
        worldHeight: 1000,

        interaction: this.pixi.renderer.plugins.interaction, // the interaction module is important for wheel to work properly when renderer.view is placed or scaled
      })

      this.pixi.stage.addChild(viewport)

      viewport
        .drag()
        .wheel({
          smooth: 10,
        })
        .decelerate()

      console.log('## systemBodies', this.systemBodies)

      const starsResult = drawSystem(viewport, this.system || {}, {
        origin: { x: this.pixi.view.width / 2, y: this.pixi.view.height / 2 },
        starSize: { sizeMode: 'luminosity', minPx: 4, maxPx: 22, scale: 5 },
        orbitStyle: { color: 0x6aa7ff, alpha: 0.35, width: 1 },
      })

      drawBodiesForSystem(starsResult.root, this.systemBodies, starsResult, { color: 0x8aa1ff, alpha: 0.5, width: 2 })

      // const starPos = new PIXI.Point(this.pixi.view.width / 2, this.pixi.view.height / 2)
      // for (const body of this.systemBodies) {
      //   drawOrbit(
      //     viewport,
      //     starPos,
      //     body,
      //     unitsToPx,
      //     { color: 0x4da3ff, alpha: 0.6, width: 1 },
      //     {
      //       orbitLine: body.BodyTypeID === 4 || body.BodyTypeID === 2, // gas giants and terrestrial planets get orbits
      //     }
      //   )
      // }

      // const graphics = new PIXI.Graphics()

      // graphics.beginFill(0xff0000)
      // graphics.drawCircle(100, 100, 50)
      // graphics.endFill()

      // viewport.addChild(graphics)

      // viewport.toWorld(100, 100)
    },
  },
  asyncComputed: {
    system: {
      async get() {
        return await this.database.models.RaceSystemSurvey.findOne({
          where: {
            SystemID: this.$props.systemId,
            RaceID: this.RaceID,
          },
          include: [
            {
              required: true,
              model: this.database.models.System,
              include: [
                {
                  required: false,
                  model: this.database.models.Star,
                },
              ],
            }
          ],
        }).then((system) => {
          console.log('Loaded system:', system)
          return system
        })
      },
      default: null,
    },
    systemBodies: {
      async get() {
        const bodies = await this.database.models.SystemBody.findAll({
          where: {
            SystemID: this.$props.systemId,
          },
          include: [
            {
              required: false,
              model: this.database.models.SystemBodyName,
              where: {
                RaceID: this.RaceID,
              },
            },
            {
              required: false,
              model: this.database.models.Star,
            },
          ],
        }).then((bodies) => {
          console.log('Loaded system bodies:', bodies)

          return bodies.map((body) => ({
            ...body.toJSON(),

            SystemBodyName: body.SystemBodyNames && body.SystemBodyNames.length ? body.SystemBodyNames[0].Name : null,
          }))
        })

        return bodies
      },
      default: [],
    },
  },
}
</script>

<style scoped>
.system-view {
  padding: 20px;
}
.system-content {
  margin-top: 20px;
}
</style>
