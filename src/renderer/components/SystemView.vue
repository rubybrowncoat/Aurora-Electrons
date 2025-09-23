<template>
  <div class="system-view">
    <div id="pixi-container" style="width: 100vw; height: calc(100vh - 64px); position: absolute; top: 64px; left: 0" />
    <h1>{{ system?.Name }}</h1>
    <div class="system-content">
      <!-- Your system view content will go here -->
      <v-btn @click="fitToContent"> Fit to Screen </v-btn>
    </div>
  </div>
</template>

<script>
import * as PIXI from 'pixi.js'

import { clamp as _clamp } from 'lodash'

import Quadtree from '@timohausmann/quadtree-js'
import { Viewport } from 'pixi-viewport'
import { mapGetters } from 'vuex'
import { starName, systemBodyName, toNumber } from '~/utilities/aurora'
import { approximatelyEquals, safeModulo360 } from '~/utilities/math'

PIXI.settings.ROUND_PIXELS = true

const SOLAR_RADIUS_KM = 695700
const SOLAR_TEMPERATURE_K = 5772
const EARTH_RADIUS_KM = 6371
const DEG2RAD = Math.PI / 180
const AU_KM = 149597870.7

const PX_PER_AU = 150
const WORLD_MAGNIFICATION = 1000

const bodyTypes = {
  1: 'Asteroid',
  2: 'Terrestrial Planet',
  3: 'Dwarf Planet',
  4: 'Gas Giant',
  5: 'Super Jovian',
  7: 'Small Moon',
  8: 'Moon',
  9: 'Large Moon',
  10: 'Small Terrestrial Moon',
  11: 'Large Terrestrial Moon',
  14: 'Comet',
}
const renderOrbitBodyType = new Set([2, 3, 4, 5, 7, 8, 9, 10, 11]) // 7, 8, 9, 10, 11
const lunarBodyTypeIds = new Set([7, 8, 9, 10, 11])

const isRenderOrbitBodyType = (id) => renderOrbitBodyType.has(toNumber(id, 0))
const isLunarBodyType = (id) => lunarBodyTypeIds.has(toNumber(id, 0))

const unitsToPx = (u) => u * PX_PER_AU * WORLD_MAGNIFICATION
const kmToPx = (km) => unitsToPx(km / AU_KM)

const TEXT_STYLES = {
  body: new PIXI.TextStyle({
    fill: 0xffffff,
    fontSize: 10,
    align: 'left',

    dropShadow: true,
    dropShadowDistance: 1,
    dropShadowBlur: 0,
    dropShadowAlpha: 1,
  }),
  star: new PIXI.TextStyle({
    fill: 0xffffff,
    fontSize: 12,
    fontWeight: 'bold',
    align: 'center',

    dropShadow: true,
    dropShadowDistance: 1,
    dropShadowBlur: 0,
    dropShadowAlpha: 1,
  }),
}

// Get WORLD rotation by summing ancestor local rotations (stable even with y-down & scales)
const getWorldRotation = (displayObject) => {
  let rot = 0
  let o = displayObject
  while (o) {
    rot += o.rotation || 0
    o = o.parent
  }
  return rot
}

// Star pixel radius from luminosity (L≈1 → readable, caps to avoid galaxy-sized suns)
const starPixelRadius = (star, sizeOpts = {}) => {
  const { exaggeration = 1, minPx = 0, maxPx = Number.POSITIVE_INFINITY } = sizeOpts

  // 1) Prefer explicit radius from StarType, in solar radii
  let rSolar = toNumber(star.StarType.Radius, NaN)

  // 2) Fallback: derive R/R☉ from L and T (L ∝ R^2 T^4)
  if (!Number.isFinite(rSolar)) {
    const L = toNumber(star.Luminosity, NaN) // L/L☉
    const T = toNumber(star.StarType.Temperature, NaN) // K
    if (Number.isFinite(L)) {
      if (Number.isFinite(T) && T > 0) {
        const tRel = T / SOLAR_TEMPERATURE_K
        rSolar = Math.sqrt(Math.max(0, L)) / (tRel * tRel)
      } else {
        // Assume T≈T☉ if we only have L
        rSolar = Math.sqrt(Math.max(0, L))
      }
    }
  }

  // 3) If still missing, last-resort tiny dot
  if (!Number.isFinite(rSolar) || rSolar <= 0) return _clamp(minPx, 0, maxPx)

  const rKm = rSolar * SOLAR_RADIUS_KM
  const rPx = kmToPx(rKm) * exaggeration
  return _clamp(rPx, minPx, maxPx)
}

const bodyPixelRadius = (body, sizeOpts = {}) => {
  const { radiusUnits = 'km', exaggeration = 1 } = sizeOpts

  let rKm = toNumber(body.Radius, 0)
  if (rKm <= 0) return 0

  if (radiusUnits === 'earthRadii') rKm *= EARTH_RADIUS_KM
  else if (radiusUnits === 'meters') rKm /= 1000

  return kmToPx(rKm) * exaggeration // world px (affected by viewport scale at render time)
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

const starColor = (star) => {
  const red = toNumber(star.StarType.Red, 0)
  const green = toNumber(star.StarType.Green, 0)
  const blue = toNumber(star.StarType.Blue, 0)

  if (!red && !green && !blue) return starColorForComponent(star.Component)

  // return hex int color
  return ((red & 0xff) << 16) | ((green & 0xff) << 8) | (blue & 0xff)
}

const drawOrbitLocal = (parentContainer, position, bodyLike, style = { color: 0x8aa1ff, alpha: 0.55, width: 2 }, opts = { orbitLine: true, keepLabelUpright: true, orbitRegistry: [], annotationRegistry: [], computedBodyPixelRadius: null, minBodyRadius: 3, labelPadPx: 8, parentWorldXkm: undefined, parentWorldYkm: undefined, nameText: undefined }) => {
  const orbitContainer = new PIXI.Container()
  orbitContainer.position.set(toNumber(position.x), toNumber(position.y))

  const isLunar = isLunarBodyType(bodyLike.BodyTypeID)

  // ---- a/e in raw units from DB (AU for planets/comets, km for moons)
  const aRaw = Math.max(0, toNumber(bodyLike.OrbitalDistance, 0))
  let e = _clamp(toNumber(bodyLike.Eccentricity, 0), 0, 0.999)

  // If e omitted, infer from DistanceToOrbitCentre using consistent units
  if ((!e || e <= 0) && Number.isFinite(bodyLike.DistanceToOrbitCentre) && aRaw > 0) {
    const cRaw = Math.max(0, toNumber(bodyLike.DistanceToOrbitCentre, 0))
    e = _clamp(cRaw / aRaw, 0, 0.999)
  }

  // Convert a/b/c → **pixels** with correct unit branch
  const bRaw = aRaw * Math.sqrt(1 - e * e)
  const cRaw = aRaw * e

  const toPx = (valRaw) => (isLunar ? unitsToPx(valRaw / AU_KM) : unitsToPx(valRaw))
  const ax = toPx(aRaw) // px
  const by = toPx(bRaw) // px
  const cx = toPx(cRaw) // px

  // Bearing angle (math degrees in DB)
  const phiDeg = toNumber(bodyLike.EccentricityDirection, 0)
  const phi = phiDeg * DEG2RAD
  const cosφ = Math.cos(phi)
  const sinφ = Math.sin(phi)

  // Optional exact DB world position (km) -> local delta (px)
  const xkm = toNumber(bodyLike.Xcor, NaN)
  const ykm = toNumber(bodyLike.Ycor, NaN)
  const pxkm = toNumber(opts.parentWorldXkm, NaN)
  const pykm = toNumber(opts.parentWorldYkm, NaN)

  let dxPx, dyPx
  if (Number.isFinite(xkm) && Number.isFinite(ykm)) {
    const dxkm = Number.isFinite(pxkm) && Number.isFinite(pykm) ? xkm - pxkm : xkm
    const dykm = Number.isFinite(pxkm) && Number.isFinite(pykm) ? ykm - pykm : ykm
    dxPx = unitsToPx(dxkm / AU_KM)
    dyPx = unitsToPx(dykm / AU_KM)
  }

  const parentWorldRot = getWorldRotation(parentContainer)
  const circleMode = isLunar || approximatelyEquals(e, 0, 1e-9)

  let localX, localY
  let cxSigned = 0

  if (circleMode) {
    // orientation irrelevant for circles; neutralize parent world rotation
    orbitContainer.rotation = -parentWorldRot

    if (Number.isFinite(dxPx) && Number.isFinite(dyPx) && (dxPx !== 0 || dyPx !== 0)) {
      localX = dxPx
      localY = dyPx
    } else {
      const bearingDeg = safeModulo360(toNumber(bodyLike.Bearing, 0))
      const nu = (bearingDeg - 90) * DEG2RAD
      localX = ax * Math.cos(nu)
      localY = ax * Math.sin(nu)
    }

    if (opts.orbitLine && aRaw > 0) {
      const g = new PIXI.Graphics()
      const w = style.width ?? 1
      g.lineStyle(w, style.color ?? 0x8aa1ff, style.alpha ?? 0.55)
      g.drawCircle(0, 0, ax)
      g._orbitMeta = {
        baseWidth: w,
        color: style.color ?? 0x8aa1ff,
        alpha: style.alpha ?? 0.55,
        isCircle: true,
        r: ax,
        lastDrawnWidth: null,
      }

      if (opts.orbitRegistry && Array.isArray(opts.orbitRegistry)) opts.orbitRegistry.push(g)
      orbitContainer.addChild(g)
    }
  } else {
    // Ellipse: keep world orientation = φ even under rotated parent
    orbitContainer.rotation = phi - parentWorldRot

    if (Number.isFinite(dxPx) && Number.isFinite(dyPx) && (dxPx !== 0 || dyPx !== 0)) {
      const lx = dxPx * cosφ + dyPx * sinφ
      const ly = -dxPx * sinφ + dyPx * cosφ
      const err = (s) => {
        const u = lx - s * cx
        const v = ly
        return Math.abs((u * u) / (ax * ax) + (v * v) / (by * by) - 1)
      }
      cxSigned = err(-1) < err(+1) ? -cx : +cx
      localX = lx
      localY = ly
    } else {
      const bearingDeg = safeModulo360(toNumber(bodyLike.Bearing, 0))
      const nu = (bearingDeg - 90) * DEG2RAD
      // r in px directly (a is ax px)
      const rPx = ax > 0 ? (ax * (1 - e * e)) / (1 + e * Math.cos(nu)) : 0
      localX = rPx * Math.cos(nu)
      localY = rPx * Math.sin(nu)
    }

    if (opts.orbitLine && (ax > 0 || by > 0)) {
      const g = new PIXI.Graphics()
      const w = style.width ?? 1
      g.lineStyle(w, style.color ?? 0x8aa1ff, style.alpha ?? 0.55)
      g.drawEllipse(cxSigned, 0, ax, by)
      g._orbitMeta = {
        baseWidth: w,
        color: style.color ?? 0x8aa1ff,
        alpha: style.alpha ?? 0.55,
        isCircle: false,
        ax,
        by,
        cx: cxSigned,
        lastDrawnWidth: null,
      }

      if (opts.orbitRegistry && Array.isArray(opts.orbitRegistry)) opts.orbitRegistry.push(g)
      orbitContainer.addChild(g)
    }
  }

  // ---- Body marker (physical world radius; redraw on zoom for min-screen clamp)
  const marker = new PIXI.Graphics()
  const physR = Math.max(1e-6, toNumber(opts.computedBodyPixelRadius, 0)) // avoid 0 for scale math

  // initial draw at the physical world radius; stroke will be normalized on first zoom refresh
  marker.lineStyle(1, 0x000000, 1)
  marker.beginFill(0xffffff, 1)
  marker.drawCircle(0, 0, physR)
  marker.endFill()

  // metadata to drive redraw-on-zoom (scale stays = 1 always)
  marker._bodyMeta = {
    isPhysical: true,
    physWorldR: physR, // world px
    minScreenR: Math.max(0, toNumber(opts.minBodyRadius, 0)), // px on screen
    fill: 0xffffff,
    stroke: 0x000000,
    strokeAlpha: 1,
    lastDrawnWorldR: -1,
  }

  if (Number.isFinite(localX) && Number.isFinite(localY)) {
    marker.position.set(localX, localY)
  } else {
    // Final fallback (unit-correct now)
    const bearingDeg = safeModulo360(toNumber(bodyLike.Bearing, 0))
    const nu = (bearingDeg - 90) * DEG2RAD
    const rPx = circleMode ? ax : (ax * (1 - e * e)) / (1 + e * Math.cos(nu))
    marker.position.set(rPx * Math.cos(nu), rPx * Math.sin(nu))
  }

  orbitContainer.addChild(marker)

  // Label
  let label = null
  if (opts.nameText) {
    label = new PIXI.Text(String(opts.nameText), TEXT_STYLES.body)
    label.anchor.set(0, 0.5)
    label.position.set(marker.x + (opts.labelPadPx ?? 8), marker.y)
    label._baseWpx = label.width
    label._baseHpx = label.height
    orbitContainer.addChild(label)
  }

  parentContainer.addChild(orbitContainer)

  // Now adjust label rotation accurately using WORLD rotation, but only if needed
  if (label) {
    const desired = opts.keepLabelUpright ? -getWorldRotation(orbitContainer) : -getWorldRotation(parentContainer)
    if (!approximatelyEquals(label.rotation, desired, 1e-6)) label.rotation = desired
  }

  if (opts.annotationRegistry && Array.isArray(opts.annotationRegistry)) {
    opts.annotationRegistry.push({
      orbitContainer,
      marker,
      label,
      keepLabelUpright: !!opts.keepLabelUpright,
      bodyTypeId: bodyLike.BodyTypeID,
      labelPadPx: opts.labelPadPx ?? 8,

      isPhysicalSizeBody: true,
      computedBodyPixelRadius: physR, // world px
      minBodyRadius: Math.max(0, toNumber(opts.minBodyRadius, 0)), // screen px
    })
  }

  return { orbitContainer, marker }
}

const drawSystem = (stage, system, stars, opts = {}) => {
  const { origin = { x: 0, y: 0 }, orbitStyle = { color: 0x6aa7ff, alpha: 0.45, width: 1 }, starSize = { exaggeration: 1, minPx: 0, maxPx: 1e7 } } = opts

  const orbitRegistry = opts.orbitRegistry || []
  const annotationRegistry = opts.annotationRegistry || []

  const root = new PIXI.Container()
  root.position.set(toNumber(origin.x), toNumber(origin.y))
  stage.addChild(root)

  // Build index by Component and by StarID
  const byComponent = new Map()
  const byStarID = new Map()
  for (const s of stars) byComponent.set(toNumber(s.Component, 1), s)

  // Sort by hierarchy depth so parents get drawn first
  const compToParent = (s) => toNumber(s.OrbitingComponent, 0)
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
  for (const [index, star] of ordered.entries()) {
    const comp = toNumber(star.Component, 1)
    const parentComp = toNumber(star.OrbitingComponent, 0)

    // Choose parent container & local focus point
    let parentContainer = root
    let parentLocal = { x: 0, y: 0 }
    let parentWorldXkm, parentWorldYkm
    if (parentComp) {
      const parentDrawn = drawnByComponent.get(parentComp)
      if (parentDrawn) {
        parentContainer = parentDrawn.orbitContainer
        parentLocal = parentDrawn.marker.position // orbit about the parent's current position
        parentWorldXkm = toNumber(parentDrawn.star.Xcor, NaN)
        parentWorldYkm = toNumber(parentDrawn.star.Ycor, NaN)
      }
    }

    const bodyLike = {
      BodyTypeID: 0, // star
      OrbitalDistance: star.OrbitalDistance,
      Eccentricity: star.Eccentricity,
      EccentricityDirection: star.EccentricityDirection,
      Bearing: star.Bearing,
      DistanceToParent: star.DistanceToParent,
      DistanceToOrbitCentre: star.DistanceToOrbitCentre,
      Xcor: star.Xcor,
      Ycor: star.Ycor,
    }

    const radiusPx = starPixelRadius(star, starSize)
    const color = starColor(star)

    // Draw the star's ORBIT path and a marker that supports min-screen clamping
    const { orbitContainer, marker } = drawOrbitLocal(
      parentContainer,
      parentLocal,
      bodyLike,
      { color, alpha: orbitStyle.alpha, width: orbitStyle.width },
      {
        orbitLine: true,
        keepLabelUpright: true,
        parentWorldXkm,
        parentWorldYkm,
        orbitRegistry,
        annotationRegistry,
        // give stars their physical size in world px
        computedBodyPixelRadius: radiusPx,
        // and a bigger on-screen minimum than planets
        minBodyRadius: opts.minStarRadius ?? 6,
      },
    )

    // color the marker like the star
    if (marker && marker._bodyMeta) {
      marker._bodyMeta.fill = color
      marker.clear()
      marker.beginFill(color, 1)
      marker.drawCircle(0, 0, marker._bodyMeta.physWorldR)
      marker.endFill()
    }

    // Label for star (bigger, always shown)
    const labelText = starName(index, system)
    const starLabel = new PIXI.Text(labelText, TEXT_STYLES.star)
    starLabel.anchor.set(0.5, 0)
    starLabel.position.set(marker.position.x, marker.position.y + (radiusPx + 6))
    starLabel._baseWpx = starLabel.width
    starLabel._baseHpx = starLabel.height
    const desired = -getWorldRotation(orbitContainer)
    if (!approximatelyEquals(starLabel.rotation, desired, 1e-6)) starLabel.rotation = desired
    orbitContainer.addChild(starLabel)

    // register star label & marker for visibility-based refresh & constant-size scaling
    if (annotationRegistry && Array.isArray(annotationRegistry)) {
      annotationRegistry.push({
        orbitContainer,
        marker,
        label: starLabel,
        keepLabelUpright: true,
        bodyTypeId: 0, // star
        labelPadPx: 6,
        starRadiusPx: radiusPx,
      })
    }

    drawnByComponent.set(comp, { orbitContainer, marker, star })
    byStarID.set(toNumber(star.StarID), { orbitContainer, marker, star })
  }

  return { root, byStarID: Object.fromEntries(byStarID), byComponent: Object.fromEntries(drawnByComponent) }
}

function drawBodyAround(parentContainer, parentLocalPos, body, style = { color: 0x8aa1ff, alpha: 0.55, width: 1 }, parentWorldXkm, parentWorldYkm, orbitRegistry = [], annotationRegistry = [], extras = {}) {
  const { sizeOpts = { radiusUnits: 'km', exaggeration: 1 }, minBodyRadius = 3 } = extras

  const rPx = Math.max(bodyPixelRadius(body, sizeOpts), 0)

  return drawOrbitLocal(parentContainer, parentLocalPos, body, style, {
    orbitLine: isRenderOrbitBodyType(body.BodyTypeID),
    keepLabelUpright: true,
    nameText: systemBodyName(body),
    parentWorldXkm,
    parentWorldYkm,
    orbitRegistry,
    annotationRegistry,
    computedBodyPixelRadius: rPx,
    minBodyRadius,
  })
}

function drawBodiesForSystem(rootContainer, bodies, starsResult, style = { color: 0x8aa1ff, alpha: 0.55, width: 1 }, orbitRegistry = [], annotationRegistry = [], extras = {}) {
  // index bodies and a depth function that climbs ParentBodyID
  const byId = new Map()
  for (const b of bodies) byId.set(toNumber(b.SystemBodyID, -1), b)

  const depthMemo = new Map()
  const depthOf = (b) => {
    const id = toNumber(b.SystemBodyID, -1)
    if (depthMemo.has(id)) return depthMemo.get(id)
    const pid = toNumber(b.ParentBodyID, 0)
    let d = 0
    if (pid && byId.has(pid)) d = 1 + depthOf(byId.get(pid))
    depthMemo.set(id, d)
    return d
  }

  // draw parents before children
  const ordered = [...bodies].sort((a, b) => depthOf(a) - depthOf(b))

  // keep where each drawn body lives (container, marker, json)
  const drawnByBodyId = new Map()

  const out = []
  for (const body of ordered) {
    const sid = toNumber(body.StarID, NaN)
    const starRef = starsResult.byStarID[String(sid)] || starsResult.byStarID[sid]

    // choose parent anchor
    let parentContainer = rootContainer
    let parentLocalPos = { x: 0, y: 0 }
    let parentWorldXkm, parentWorldYkm

    const parentBodyId = toNumber(body.ParentBodyID, 0)
    if (parentBodyId && drawnByBodyId.has(parentBodyId)) {
      const parentDrawn = drawnByBodyId.get(parentBodyId)
      parentContainer = parentDrawn.orbitContainer
      parentLocalPos = parentDrawn.marker.position
      parentWorldXkm = toNumber(parentDrawn.body.Xcor, NaN)
      parentWorldYkm = toNumber(parentDrawn.body.Ycor, NaN)
    } else if (starRef) {
      parentContainer = starRef.orbitContainer
      parentLocalPos = starRef.marker.position
      parentWorldXkm = starRef.star && toNumber(starRef.star.Xcor, NaN)
      parentWorldYkm = starRef.star && toNumber(starRef.star.Ycor, NaN)
    }

    const r = drawBodyAround(parentContainer, parentLocalPos, body, style, parentWorldXkm, parentWorldYkm, orbitRegistry, annotationRegistry, extras)

    drawnByBodyId.set(toNumber(body.SystemBodyID, -1), { ...r, body })
    out.push(r)
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
      _initRaf: null,
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),
  },
  watch: {
    system: 'scheduleInitPixi',
    stars: 'scheduleInitPixi',
    systemBodies: 'scheduleInitPixi',
  },
  mounted() {},
  beforeDestroy() {
    if (this.pixi) {
      console.log('Destroying PIXI application??')
      this.pixi.destroy(true, true)
      this.pixi = null
    }

    if (this._annotationRaf) {
      cancelAnimationFrame(this._annotationRaf)
      this._annotationRaf = null
    }
  },
  methods: {
    loog(...asd) {
      console.log(...asd)
    },

    _labelPriority(entry) {
      switch (entry.bodyTypeId) {
        case 0:
          return 1000 // stars highest
        case 5:
          return 900 // Super Jovian
        case 4:
          return 800 // Gas Giant
        case 2:
          return 600 // Terrestrial Planet
        case 3:
          return 500 // Dwarf Planet
        case 11:
          return 400 // Large Terrestrial Moon
        case 10:
          return 350 // Small Terrestrial Moon
        case 9:
          return 300 // Large Moon
        case 8:
          return 250 // Moon
        case 7:
          return 220 // Small Moon
        case 14:
          return 200 // Comet
        default:
          return 100 // everything else
      }
    },

    _labelScreenRect(label) {
      // Convert label world bounds to screen-space rect
      const b = label.getBounds()
      const p1 = this.viewport.toScreen(b.x, b.y)
      const p2 = this.viewport.toScreen(b.x + b.width, b.y + b.height)
      const x = Math.min(p1.x, p2.x)
      const y = Math.min(p1.y, p2.y)
      const w = Math.abs(p2.x - p1.x)
      const h = Math.abs(p2.y - p1.y)
      return { x, y, w, h }
    },

    _rectsOverlap(a, b) {
      return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)
    },

    // Compute & cache an orbit's WORLD-space AABB into g._orbitMeta.aabbWorld
    _cacheOrbitAABB(g) {
      const m = g && g._orbitMeta
      const oc = g && g.parent
      if (!m || !oc || !this.viewport) return

      // center (local): ellipse center is at (cx, 0); circle at (0, 0)
      const cl = m.isCircle ? { x: 0, y: 0 } : { x: m.cx, y: 0 }

      // center in world units used by viewport helpers
      const cg = oc.toGlobal(cl) // stage px
      const cw = this.viewport.toWorld(cg.x, cg.y) // world px

      // world rotation of the orbit container (constant after init)
      const alpha = getWorldRotation(oc)
      let hx, hy

      if (m.isCircle) {
        hx = hy = m.r // world px
      } else {
        const ax = m.ax
        const by = m.by
        const c = Math.cos(alpha)
        const s = Math.sin(alpha)
        // AABB of rotated ellipse
        hx = Math.sqrt(ax * ax * c * c + by * by * s * s)
        hy = Math.sqrt(ax * ax * s * s + by * by * c * c)
      }

      m.aabbWorld = { xMin: cw.x - hx, xMax: cw.x + hx, yMin: cw.y - hy, yMax: cw.y + hy }
      // Optional: cache a quick LOD radius
      m.radiusWorld = m.isCircle ? m.r : Math.max(m.ax, m.by)
    },

    // Build AABBs for all orbits once
    _cacheAllOrbitAABBs() {
      if (!this._orbitRegistry) return
      for (const g of this._orbitRegistry) this._cacheOrbitAABB(g)
    },

    redrawOrbitStrokes() {
      if (!this._orbitRegistry || !this.viewport) return

      const s = this.viewport.scale?.x || 1
      const visible = this._getVisibleWorldRect(0)
      const MIN_ORBIT_SCREEN_R = 1.5

      for (const g of this._orbitRegistry) {
        const m = g._orbitMeta
        if (!m) continue

        // Quick LOD
        const radiusWorld = m.radiusWorld ?? (m.isCircle ? m.r : Math.max(m.ax, m.by))
        const radiusScreen = radiusWorld * s
        if (radiusScreen < MIN_ORBIT_SCREEN_R) {
          g.renderable = false
          continue
        }

        // Cached AABB (fallback to compute if missing)
        const box = m.aabbWorld || (this._cacheOrbitAABB(g), m.aabbWorld)
        if (!box) {
          g.renderable = false
          continue
        }

        const intersects = !(box.xMax < visible.xMin || box.xMin > visible.xMax || box.yMax < visible.yMin || box.yMin > visible.yMax)

        g.renderable = intersects
        if (!g.renderable) continue

        // keep constant stroke width
        const w = m.baseWidth / s
        if (approximatelyEquals(m.lastDrawnWidth ?? -1, w, 1e-3)) continue
        m.lastDrawnWidth = w

        g.clear()
        g.lineStyle(w, m.color, m.alpha)
        if (m.isCircle) g.drawCircle(0, 0, m.r)
        else g.drawEllipse(m.cx, 0, m.ax, m.by)
      }
    },

    // redrawOrbitStrokes() {
    //   const MIN_ORBIT_SCREEN_RADIUS = 1.5

    //   if (!this._orbitRegistry || !this.viewport) return
    //   const s = this.viewport.scale?.x || 1
    //   for (const g of this._orbitRegistry) {
    //     const m = g._orbitMeta
    //     if (!m) continue

    //     // LOD: skip drawing orbits whose on-screen radius < ~0.75px
    //     const radiusWorld = m.isCircle ? m.r : Math.max(m.ax, m.by)
    //     const radiusScreen = radiusWorld * s
    //     g.renderable = radiusScreen >= MIN_ORBIT_SCREEN_RADIUS
    //     if (!g.renderable) continue

    //     const w = m.baseWidth / s
    //     if (approximatelyEquals(m.lastDrawnWidth ?? -1, w, 1e-3)) continue
    //     m.lastDrawnWidth = w
    //     g.clear()
    //     g.lineStyle(w, m.color, m.alpha)
    //     if (m.isCircle) g.drawCircle(0, 0, m.r)
    //     else g.drawEllipse(m.cx, 0, m.ax, m.by)
    //   }
    // },

    redrawPhysicalBodyMarkers() {
      if (!this._annotationRegistry || !this.viewport) return
      const s = this.viewport.scale?.x || 1
      const invS = 1 / s

      for (const entry of this._annotationRegistry) {
        const marker = entry?.marker
        const meta = marker && marker._bodyMeta
        if (!marker || !meta || !meta.isPhysical) continue

        const physWorldR = meta.physWorldR
        const minScreenR = entry.minBodyRadius ?? meta.minScreenR ?? 0

        // target on-screen radius = max(physical*s, minScreen)
        const physScreenR = physWorldR * s
        const targetScreenR = Math.max(physScreenR, minScreenR)
        const targetWorldR = targetScreenR * invS

        if (approximatelyEquals(meta.lastDrawnWorldR ?? -1, targetWorldR, 1e-3)) continue

        meta.lastDrawnWorldR = targetWorldR
        marker.clear()
        // 1 px stroke on screen -> stroke width in world units is (1 * invS)
        // marker.lineStyle(1 * invS, meta.stroke, meta.strokeAlpha)
        marker.beginFill(meta.fill, 1)
        marker.drawCircle(0, 0, targetWorldR)
        marker.endFill()
      }
    },

    // Compute world-visible rectangle of the viewport (with optional padding)
    _getVisibleWorldRect(pad = 0) {
      const tl = this.viewport.toWorld(0, 0)
      const br = this.viewport.toWorld(this.pixi.view.width, this.pixi.view.height)
      const xMin = Math.min(tl.x, br.x) - pad
      const xMax = Math.max(tl.x, br.x) + pad
      const yMin = Math.min(tl.y, br.y) - pad
      const yMax = Math.max(tl.y, br.y) + pad
      return { xMin, xMax, yMin, yMax }
    },

    // Visibility test using marker bounds (cheap) against world rect
    _isMarkerVisible(entry, rect) {
      if (!entry || !entry.marker) return false
      const markerPosition = this.viewport.toWorld(entry.marker.getGlobalPosition())
      if (!markerPosition) return false

      if (markerPosition.x < rect.xMin || markerPosition.x > rect.xMax) return false
      if (markerPosition.y < rect.yMin || markerPosition.y > rect.yMax) return false

      return true
    },

    refreshVisibleAnnotations() {
      if (!this._annotationRegistry || !this.viewport) return
      const rect = this._getVisibleWorldRect(64) // small padding
      const candidates = []

      for (const entry of this._annotationRegistry) {
        const visible = this._isMarkerVisible(entry, rect)

        if (!visible) {
          if (entry.label) entry.label.renderable = false
          if (entry.marker) entry.marker.renderable = false
          continue
        }

        if (entry.marker) entry.marker.renderable = true

        // label placement
        if (entry.label) {
          const s = this.viewport.scale?.x || 1
          const invS = 1 / s
          if (!approximatelyEquals(entry.label.scale?.x, invS, 1e-3) || !approximatelyEquals(entry.label.scale?.y, invS, 1e-3)) {
            entry.label.scale.set(invS, invS)
          }

          const pad = entry.labelPadPx ?? 8
          let targetX, targetY

          if (typeof entry.starRadiusPx === 'number') {
            const dWorldY = entry.starRadiusPx + pad * invS
            targetX = entry.marker?.x ?? 0
            targetY = (entry.marker?.y ?? 0) + dWorldY
          } else if (entry.isPhysicalSizeBody && entry.computedBodyPixelRadius > 0) {
            const physWorldR = entry.computedBodyPixelRadius
            const minScreenR = entry.minBodyRadius ?? 0
            const effectiveScreenR = Math.max(physWorldR * s, minScreenR)
            const dWorldX = (effectiveScreenR + pad) * invS
            targetX = (entry.marker?.x ?? 0) + dWorldX
            targetY = entry.marker?.y ?? 0
          } else {
            const markerBase = entry.markerBaseRadiusPx ?? 3
            const dWorldX = (markerBase + pad) * invS
            targetX = (entry.marker?.x ?? 0) + dWorldX
            targetY = entry.marker?.y ?? 0
          }

          if (!approximatelyEquals(entry.label.x, targetX, 1e-3) || !approximatelyEquals(entry.label.y, targetY, 1e-3)) {
            entry.label.position.set(targetX, targetY)
          }

          candidates.push({ entry, priority: this._labelPriority(entry) })
        }
      }

      // Resolve overlaps by hierarchy priority (higher wins)
      if (candidates.length) {
        candidates.sort((a, b) => b.priority - a.priority)
        const accepted = []
        for (const c of candidates) {
          const r = this._labelScreenRect(c.entry.label)
          let overlaps = false
          for (const ar of accepted) {
            if (this._rectsOverlap(r, ar)) {
              overlaps = true
              break
            }
          }
          c.entry.label.renderable = !overlaps
          if (!overlaps) accepted.push(r)
        }
      }
    },

    _scheduleVisibleAnnotationsRefresh() {
      if (this._annotationRaf) return
      this._annotationRaf = requestAnimationFrame(() => {
        this._annotationRaf = null
        this.refreshVisibleAnnotations()
      })
    },

    // --- Bounds helpers ----------------------------------------------------
    _boundsInit() {
      return { xMin: Infinity, yMin: Infinity, xMax: -Infinity, yMax: -Infinity }
    },
    _boundsExpandPoint(b, x, y) {
      if (x < b.xMin) b.xMin = x
      if (y < b.yMin) b.yMin = y
      if (x > b.xMax) b.xMax = x
      if (y > b.yMax) b.yMax = y
    },
    _boundsExpandRect(b, x1, y1, x2, y2) {
      this._boundsExpandPoint(b, x1, y1)
      this._boundsExpandPoint(b, x2, y2)
    },

    estimateScaleToFit(bounds) {
      const sw = this.pixi?.view?.width || 1
      const sh = this.pixi?.view?.height || 1
      const bw = Math.max(bounds.width, 1e-6)
      const bh = Math.max(bounds.height, 1e-6)
      return Math.min(sw / bw, sh / bh)
    },
    
    // Fast, scale-aware union of world AABBs.
    // Options:
    //   includeLabels: include label boxes (default: true)
    //   includeMarkers: include body/star discs (default: true)
    //   assumeScale: if provided, sizes that depend on on-screen px (labels, min-radius)
    //                are computed for this scale instead of the current zoom.
    computeSceneBounds(paddingScreenPx = 64, {
      includeLabels = true,
      includeMarkers = true,
      assumeScale = null,
    } = {}) {
      if (!this.viewport) return null

      const toWorld = (gx, gy) => this.viewport.toWorld(gx, gy)
      const b = this._boundsInit()
      let any = false

      // ---- 1) Orbits: use cached world AABBs (built by _cacheAllOrbitAABBs)
      if (this._orbitRegistry) {
        for (const g of this._orbitRegistry) {
          const m = g && g._orbitMeta
          if (!m || !m.aabbWorld) continue
          this._boundsExpandRect(b, m.aabbWorld.xMin, m.aabbWorld.yMin, m.aabbWorld.xMax, m.aabbWorld.yMax)
          any = true
        }
      }

      // We'll need a scale to translate px-sized things (labels, min-screen radii) to world units.
      // If not provided, estimate from the orbit-only union (fast) or fall back to current zoom.
      const sCurrent = this.viewport.scale?.x || 1
      let sTarget = assumeScale
      if (!sTarget) {
        if (any) {
          const tmp = { ...b, width: b.xMax - b.xMin, height: b.yMax - b.yMin }
          sTarget = this.estimateScaleToFit(tmp)
        } else {
          sTarget = sCurrent
        }
      }
      const invSTarget = 1 / sTarget

      // Helper: expand by a world-aligned box centered at (cx,cy)
      const _expandCentered = (cx, cy, halfW, halfH) => {
        this._boundsExpandRect(b, cx - halfW, cy - halfH, cx + halfW, cy + halfH)
      }

      // ---- 2) Markers (discs): compute center via one toGlobal+toWorld, size analytically
      if (includeMarkers && this._annotationRegistry) {
        for (const entry of this._annotationRegistry) {
          const marker = entry?.marker
          if (!marker) continue
          const meta = marker._bodyMeta
          if (!meta || !meta.isPhysical) continue

          // center in world
          const oc = entry.orbitContainer
          if (!oc) continue
          const gp = oc.toGlobal(marker.position)          // stage px
          const cw = toWorld(gp.x, gp.y)                   // world px

          // world radius for target scale = max(physWorldR, minScreenR / sTarget)
          const physRWorld = meta.physWorldR || 0
          const minScreenRpx = entry.minBodyRadius ?? meta.minScreenR ?? 0
          const rWorld = Math.max(physRWorld, minScreenRpx * invSTarget)

          _expandCentered(cw.x, cw.y, rWorld, rWorld)
          any = true
        }
      }

      // ---- 3) Labels: use cached intrinsic px size / target scale
      if (includeLabels && this._annotationRegistry) {
        for (const entry of this._annotationRegistry) {
          const label = entry?.label
          const oc = entry?.orbitContainer
          if (!label || !oc) continue

          const gp = oc.toGlobal({ x: label.x, y: label.y }) // stage px
          const cw = toWorld(gp.x, gp.y)                      // world px

          const wpx = label._baseWpx ?? label.width ?? 0
          const hpx = label._baseHpx ?? label.height ?? 0
          const halfW = (wpx * 0.5) * invSTarget
          const halfH = (hpx * 0.5) * invSTarget

          _expandCentered(cw.x, cw.y, halfW, halfH)
          any = true
        }
      }

      if (!any) return null

      // ---- 4) Padding in world units at target scale
      const padWorld = (paddingScreenPx || 0) * invSTarget
      b.xMin -= padWorld
      b.yMin -= padWorld
      b.xMax += padWorld
      b.yMax += padWorld

      return { ...b, width: b.xMax - b.xMin, height: b.yMax - b.yMin, cx: (b.xMin + b.xMax) / 2, cy: (b.yMin + b.yMax) / 2 }
    },

    createQuadTree(padding = 64) {
      if (!this.viewport) return null
      const toWorldXY = (gx, gy) => this.viewport.toWorld(gx, gy)
      const b = this._boundsInit()

      // 2) Markers, Labels, and Star Sprites clearance
      if (this._annotationRegistry) {
        for (const entry of this._annotationRegistry) {
          // Marker rect
          if (entry.marker) {
            const mb = entry.marker.getBounds()
            const tl = toWorldXY(mb.x, mb.y)
            const br = toWorldXY(mb.x + mb.width, mb.y + mb.height)
            this._boundsExpandRect(b, tl.x, tl.y, br.x, br.y)
          }
          // Label rect
          if (entry.label) {
            const lb = entry.label.getBounds()
            const tl = toWorldXY(lb.x, lb.y)
            const br = toWorldXY(lb.x + lb.width, lb.y + lb.height)
            this._boundsExpandRect(b, tl.x, tl.y, br.x, br.y)
          }
          // Star sprite clearance (radius around marker in local space)
          if (typeof entry.starRadiusPx === 'number' && entry.orbitContainer && entry.marker) {
            const oc = entry.orbitContainer
            const r = entry.starRadiusPx
            const tlg = oc.toGlobal({ x: entry.marker.x - r, y: entry.marker.y - r })
            const brg = oc.toGlobal({ x: entry.marker.x + r, y: entry.marker.y + r })
            const tl = toWorldXY(tlg.x, tlg.y)
            const br = toWorldXY(brg.x, brg.y)
            this._boundsExpandRect(b, tl.x, tl.y, br.x, br.y)
          }
        }
      }

      b.xMin -= padding
      b.yMin -= padding
      b.xMax += padding
      b.yMax += padding

      const quadTree = new Quadtree({
        width: b.xMax - b.xMin,
        height: b.yMax - b.yMin,
        maxDepth: 8,
        maxChildren: 10,
      })

      return quadTree
    },

    getPrimaryStarWorldCenter() {
      const sr = this._starsResult
      if (!sr) return null

      // Prefer Component 1; fallback to any with OrbitingComponent===0; else first
      const primary =
        (sr.byComponent && (sr.byComponent[1] || sr.byComponent['1'])) ||
        Object.values(sr.byComponent || {}).find(e => toNumber(e.star?.OrbitingComponent, 0) === 0) ||
        Object.values(sr.byComponent || {})[0]

      if (!primary || !primary.marker) return null
      const gp = primary.marker.getGlobalPosition()
      return this.viewport.toWorld(gp.x, gp.y)
    },

    fitToContent() {
      if (!this.viewport) return
      // Pass 1: orbits + markers, fast
      const b1 = this.computeSceneBounds(24, { includeLabels: false, includeMarkers: true })
      if (!b1) return

      const sFit = this.estimateScaleToFit(b1)

      // Pass 2: include labels using the target scale
      const b2 = this.computeSceneBounds(24, { includeLabels: true, includeMarkers: true, assumeScale: sFit })

      const desired = this.getPrimaryStarWorldCenter() || { x: b2.cx, y: b2.cy }

      // Create a new bounds that is centered on desired and contains the original bounds
      const leftExtent = desired.x - b2.xMin
      const rightExtent = b2.xMax - desired.x
      const newHalfWidth = Math.max(leftExtent, rightExtent)
      const newXMin = desired.x - newHalfWidth
      const newXMax = desired.x + newHalfWidth

      const topExtent = desired.y - b2.yMin
      const bottomExtent = b2.yMax - desired.y
      const newHalfHeight = Math.max(topExtent, bottomExtent)
      const newYMin = desired.y - newHalfHeight
      const newYMax = desired.y + newHalfHeight

      const newBounds = {
        xMin: newXMin,
        xMax: newXMax,
        yMin: newYMin,
        yMax: newYMax,
        width: newXMax - newXMin,
        height: newYMax - newYMin,
        cx: desired.x,
        cy: desired.y,
      }

      // Fit & center
      this.viewport.fit(false, newBounds.width, newBounds.height)
      this.viewport.snap(newBounds.cx, newBounds.cy, { time: 0, removeOnComplete: true })

      this._scheduleVisibleAnnotationsRefresh()
      this.redrawOrbitStrokes()
      this.redrawPhysicalBodyMarkers()
    },

    scheduleInitPixi() {
      if (this._initRaf) cancelAnimationFrame(this._initRaf)
      this._initRaf = requestAnimationFrame(() => {
        this._initRaf = null

        // Only initialize when we actually have stars (bodies may be empty)
        if (!Array.isArray(this.stars) || this.stars.length === 0) return
        this.initPixi()
      })
    },

    initPixi() {
      // extra safety: bail if stars not ready yet
      if (!Array.isArray(this.stars) || this.stars.length === 0) {
        console.warn('initPixi: stars not loaded yet')
        return
      }

      if (this.pixi) {
        this.pixi.destroy(true, true)
        this.pixi = null
      }

      console.log('SystemView mounted', this.$props)

      this.pixi = new PIXI.Application({
        width: window.innerWidth,
        height: window.innerHeight - 64, // Adjust for toolbar height
        backgroundColor: 0x000040,
        antialias: false,
      })

      const pixiContainer = document.getElementById('pixi-container')
      if (pixiContainer) {
        pixiContainer.appendChild(this.pixi.view)
      } else {
        console.warn('No pixi-container found... Aborting PIXI initialization.')

        return
      }

      this.viewport = new Viewport({
        screenWidth: window.innerWidth,
        screenHeight: window.innerHeight - 64, // Adjust for toolbar height
        worldWidth: 1000,
        worldHeight: 1000,

        interaction: this.pixi.renderer.plugins.interaction, // the interaction module is important for wheel to work properly when renderer.view is placed or scaled
      })

      this.pixi.stage.addChild(this.viewport)

      this.viewport
        .drag()
        .wheel({
          // smooth: 10,
        })
        .decelerate()

      console.log('## systemBodies', this.systemBodies)

      this._orbitRegistry = []
      this._annotationRegistry = []

      const starsResult = drawSystem(this.viewport, this.system || {}, this.stars, {
        origin: { x: this.pixi.view.width / 2, y: this.pixi.view.height / 2 },
        starSize: { exaggeration: 1, minPx: 0, maxPx: 1e7 },
        minStarRadius: 6,
        orbitStyle: { color: 0x00ff00, alpha: 0.35, width: 1 },
        orbitRegistry: this._orbitRegistry,
        annotationRegistry: this._annotationRegistry,
      })

      this._starsResult = starsResult

      drawBodiesForSystem(starsResult.root, this.systemBodies, starsResult, { color: 0x00ff00, alpha: 0.5, width: 2 }, this._orbitRegistry, this._annotationRegistry, {
        minBodyRadius: 3,
        sizeOpts: {
          // choose what you prefer:
          // radiusUnits: 'km', exaggeration: 1,  minPx: 0,    // strict physical realism
          radiusUnits: 'km',
          exaggeration: 1,
          // radiusUnits: 'km', exaggeration: 500, minPx: 0.5, // gently magnified for readability
          // radiusUnits: 'earthRadii', exaggeration: 1, minPx: 0.5, // if Radius is in R⊕
        },
      })

      this.annotationQuadTree = this.createQuadTree()

      for (const entry of this._annotationRegistry) {
        if (entry.marker) {
          const worldPosition = this.viewport.toWorld(entry.marker.getGlobalPosition())

          this.annotationQuadTree.insert({
            x: worldPosition.x - 10,
            y: worldPosition.y - 10,
            width: 20,
            height: 20,
            entry,
          })
        }
      }

      this._cacheAllOrbitAABBs()

      // keep stroke width constant across zoom levels
      const refreshStroke = () => {
        this.redrawOrbitStrokes()
      }

      const refreshBodies = () => {
        this.redrawPhysicalBodyMarkers()
      }

      const schedule = () => {
        this._scheduleVisibleAnnotationsRefresh()
      }

      this.viewport.addListener('moved', schedule)
      this.viewport.addListener('zoomed', schedule)
      this.viewport.addListener('pinch', schedule)

      this.viewport.addListener('moved', refreshStroke)
      this.viewport.addListener('zoomed', refreshStroke)
      this.viewport.addListener('pinch', refreshStroke)

      this.viewport.addListener('zoomed', refreshBodies)
      this.viewport.addListener('pinch', refreshBodies)
      
      this.fitToContent()
    },
  },
  asyncComputed: {
    system: {
      async get() {
        if (!this.database || !this.RaceID) {
          return null
        }

        return await this.database.models.RaceSystemSurvey.findOne({
          where: {
            SystemID: this.$props.systemId,
            RaceID: this.RaceID,
          },
          include: [
            {
              required: true,
              model: this.database.models.System,
            },
          ],
        }).then((system) => {
          console.log('Loaded system:', system.toJSON())
          return system
        })
      },
      default: null,
    },
    stars: {
      async get() {
        if (!this.database) {
          return []
        }

        return await this.database.models.Star.findAll({
          where: {
            SystemID: this.$props.systemId,
          },
          include: [
            {
              required: true,
              model: this.database.models.StarType,
            },
          ],
        }).then((stars) => {
          console.log('Loaded stars:', stars)
          return stars
        })
      },
      default: [],
    },
    systemBodies: {
      async get() {
        if (!this.database || !this.RaceID) {
          return []
        }

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

<style scoped></style>
