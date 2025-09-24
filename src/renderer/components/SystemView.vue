<template>
  <div class="system-view">
    <div id="pixi-container" style="width: 100vw; height: calc(100vh - 64px); position: absolute; top: 64px; left: 0" />
    <h1>{{ elements.system?.Name }}</h1>
    <div class="system-content">
      <!-- Your system view content will go here -->
      <v-btn @click="fitToContent"> Fit to Screen </v-btn>
    </div>
  </div>
</template>

<script>
import * as PIXI from 'pixi.js'

import { clamp as _clamp } from 'lodash'
import { color, hsl } from 'd3-color'

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

const intToHexStr = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0')
const toHexInt = (c) => parseInt(color(c).formatHex().slice(1), 16)
const hslToInt = (h, s, l) => toHexInt(hsl(h, _clamp(s, 0, 1), _clamp(l, 0, 1)))
const lightenInt = (hexInt, amt) => {
  const c = hsl(intToHexStr(hexInt))
  c.l = _clamp(c.l + (1 - c.l) * _clamp(amt, 0, 1), 0, 1)
  return toHexInt(c)
}
const darkenInt = (hexInt, amt) => {
  const c = hsl(intToHexStr(hexInt))
  c.l = _clamp(c.l * (1 - _clamp(amt, 0, 1)), 0, 1)
  return toHexInt(c)
}
const jitter = (seed) => {
  const x = (toNumber(seed, 0) * 9301 + 49297) % 233280
  return x / 233280 // 0..1
}
const pickBodyColor = (body) => {
  // --- raw fields (defensive) ---
  const t = body.SurfaceTemp ?? body.BaseTemp // °C
  const hydro = toNumber(body.HydroID, 1) // 1..4
  const rawHydroExt = toNumber(body.HydroExt, 0)
  const hydroPct = rawHydroExt > 1 ? _clamp(rawHydroExt / 100, 0, 1) : _clamp(rawHydroExt, 0, 1)
  const atm = toNumber(body.AtmosPress, 0) // ~bars
  const terrain = toNumber(body.DominantTerrain, 0)
  const type = toNumber(body.BodyTypeID, 0)
  const ring = toNumber(body.Ring, 0)
  const albedo = _clamp(toNumber(body.Albedo, 0.9), 0, 1)
  const sid = toNumber(body.SystemBodyID, 0)

  // --- type buckets from your mapping ---
  const isAsteroid = type === 1
  const isComet = type === 14
  const isGasGiant = type === 4 || type === 5
  const isTerrestrialLike = [2, 8, 9, 10, 11].includes(type)
  const isDwarf = type === 3
  const isSmallMoon = type === 7

  // --- terrain palette (dominant cues) ---
  const TERRAIN = {
    10: 0xe8c07d,
    22: 0xd5d0c4,
    39: 0xe7984b,
    31: 0xe0b476,
    34: 0x91c76e,
    4: 0x4fae5a,
    30: 0x588f5d,
    5: 0x1e8f3d,
    27: 0x16a34a,
    6: 0xa6c7d1,
    23: 0xbfe9ff,
    1: 0xa3a3a3,
    3: 0x888c9a,
    8: 0x5c8f64,
    11: 0x6da090,
    7: 0x3f5d2e,
  }

  // --- asteroids & comets ---
  if (isAsteroid) {
    const base = 0x7a7a7a
    const j = (jitter(sid) - 0.5) * 0.25 // +/-12.5%
    const mixed = j >= 0 ? lightenInt(base, j) : darkenInt(base, -j)
    const rocky = darkenInt(mixed, 0.2)

    return { fill: rocky, stroke: darkenInt(rocky, 0.35), ring: null }
  }

  if (isComet) {
    const ice = 0xbfd8f7 // icy gray-blue
    const j = (jitter(sid) - 0.5) * 0.2
    const c = j >= 0 ? lightenInt(ice, j) : darkenInt(ice, -j)

    return { fill: c, stroke: darkenInt(c, 0.35), ring: null }
  }

  // --- gas & super-jovians ---
  if (isGasGiant) {
    const T = t ?? 80
    let base
    if (T < -50) base = hslToInt(200, 0.35, 0.7) // cold: bluish
    else if (T < 20) base = hslToInt(38, 0.35, 0.72) // cool: pale tan
    else if (T < 120) base = hslToInt(28, 0.45, 0.6) // warm: beige
    else base = hslToInt(18, 0.55, 0.48) // hot: orange-brown
    // albedo tweak + super-jovians a bit deeper
    base = albedo > 0.9 ? lightenInt(base, 0.06) : darkenInt(base, 0.06 * (1 - albedo))
    if (type === 5) base = darkenInt(base, 0.08)
    const stroke = darkenInt(base, 0.25)
    const ringColor = ring ? lightenInt(base, 0.18) : null

    return { fill: base, stroke, ring: ringColor }
  }

  // --- water-first logic (terrestrial-like, dwarfs, small moons) ---
  const useTerrain = () => {
    if (terrain && TERRAIN[terrain]) {
      let base = TERRAIN[terrain]
      const air = _clamp(atm / 1.0, 0, 1) // richer with thicker air up to ~1 bar
      base = lightenInt(base, 0.06 * air)
      return base
    }
    return null
  }

  const waterStateColor = () => {
    if (hydro === 3 && hydroPct > 0) {
      // liquid water
      let ocean = 0x2a7fff
      ocean = lightenInt(ocean, 0.15 * (1 - hydroPct))
      return ocean
    }
    if (hydro === 4 && hydroPct > 0) {
      // ice sheet
      return 0xcfefff
    }
    if (hydro === 2 && hydroPct > 0) {
      // vapor/cloudy
      return 0x8ed8ff
    }
    return null
  }

  const climateFallback = () => {
    if (t === undefined || t === null) return null
    if (t < -30) return 0xc9e8ff // icy
    if (t < 5) return 0xa6c7d1 // tundra
    if (t < 25) return 0x6dbb7a // temperate
    if (t < 45) return 0x9fcb6c // warm grass/savanna
    return 0xe0a763 // hot desert
  }

  const finish = (base) => {
    // Slight desat for dwarfs/small moons; slight boost for big terrestrial
    if (isDwarf || isSmallMoon) base = darkenInt(base, 0.06)
    if (isTerrestrialLike && (type === 2 || type === 11 || type === 9)) base = lightenInt(base, 0.04)
    // Atmosphere richness (thin airless → duller)
    base = albedo > 0.95 ? lightenInt(base, 0.05) : base
    const stroke = darkenInt(base, 0.35)
    return { fill: base, stroke, ring: ring ? lightenInt(base, 0.18) : null }
  }

  // Small moons lean rocky/icy even without rich terrain
  if (isSmallMoon) {
    const w = waterStateColor()
    if (w) return finish(w)
    const base = t !== undefined && t < -50 ? 0xbfd8f7 : 0x9ba3ae
    return finish(base)
  }

  // Dwarfs: often cold/icy; otherwise neutral rocky
  if (isDwarf) {
    const w = waterStateColor()
    if (w) return finish(w)
    const terr = useTerrain()
    if (terr) return finish(terr)
    const base = climateFallback() ?? 0x9ba3ae
    return finish(base)
  }

  // Terrestrial-like (planets & bigger moons)
  if (isTerrestrialLike) {
    const w = waterStateColor()
    if (w) return finish(w)
    const terr = useTerrain()
    if (terr) return finish(terr)
    const base = climateFallback() ?? 0x9ba3ae
    return finish(base)
  }

  // absolute fallback
  const rocky = 0x9ba3ae

  return { fill: rocky, stroke: 0x556070, ring: ring ? 0xb3bbc7 : null }
}

const unitsToPx = (u) => u * PX_PER_AU * WORLD_MAGNIFICATION
const kmToPx = (km) => unitsToPx(km / AU_KM)

const TEXT_STYLES = {
  body: new PIXI.TextStyle({
    fill: 0xffffff,
    fontSize: 12,
    // align: 'left',

    dropShadow: true,
    dropShadowDistance: 1,
    // dropShadowBlur: 0,
    // dropShadowAlpha: 1,
  }),
  star: new PIXI.TextStyle({
    fill: 0xffffff,
    fontSize: 16,
    fontWeight: 'bold',

    dropShadow: true,
    dropShadowDistance: 2,
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
    elements: 'scheduleInitPixi',
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

    if (this._initRaf) {
      cancelAnimationFrame(this._initRaf)
      this._initRaf = null
    }

    if (this._texCache) {
      for (const k of Object.keys(this._texCache)) {
        this._texCache[k].destroy(true)
      }
      this._texCache = null
    }
  },
  methods: {
    loog(...asd) {
      console.log(...asd)
    },

    _makeTriangleTexture(size = 96) {
      const g = new PIXI.Graphics()
      const m = size * 0.5
      // draw a centered triangle; white so we can tint
      g.beginFill(0xffffff, 1)
      g.moveTo(m, m - m)
      g.lineTo(m - m, m + m)
      g.lineTo(m + m, m + m)
      g.closePath()
      g.endFill()
      const tex = this.pixi.renderer.generateTexture(g, { resolution: 1, scaleMode: PIXI.SCALE_MODES.LINEAR })
      g.destroy(true)
      return tex
    },

    _makeSquareTexture(size = 96) {
      const g = new PIXI.Graphics()
      const m = size * 0.5
      // draw a centered square; white so we can tint
      g.beginFill(0xffffff, 1)
      g.drawRect(m - m, m - m, size, size)
      g.endFill()
      const tex = this.pixi.renderer.generateTexture(g, { resolution: 1, scaleMode: PIXI.SCALE_MODES.LINEAR })
      g.destroy(true)
      return tex
    },

    _makeRectTexture(size = 96, aspect = 0.4) {
      const g = new PIXI.Graphics()
      const w = size
      const h = Math.max(1, Math.round(size * aspect)) // “flat square”
      const x = (size - w) * 0.5
      const y = (size - h) * 0.5
      g.beginFill(0xffffff, 1)
      g.drawRect(x, y, w, h)
      g.endFill()
      const tex = this.pixi.renderer.generateTexture(g, { resolution: 1, scaleMode: PIXI.SCALE_MODES.LINEAR })
      g.destroy(true)
      return tex
    },

    _makeSquareOutlineTexture(size = 256, strokeFrac = 0.08) {
      const g = new PIXI.Graphics()
      const stroke = Math.max(1, Math.round(size * strokeFrac))
      const pad = Math.ceil(stroke / 2)
      g.lineStyle(stroke, 0xffffff, 1)        // white; we'll tint later
      g.drawRect(pad, pad, size - 2 * pad, size - 2 * pad)
      const tex = this.pixi.renderer.generateTexture(g, { resolution: 1, scaleMode: PIXI.SCALE_MODES.LINEAR })
      g.destroy(true)
      return tex
    },

    _makeCircleTexture(size = 96) {
      // size: texture size in pixels (screen px), power of two is nice but not required
      const g = new PIXI.Graphics()
      const r = size / 2
      g.beginFill(0xffffff, 1) // white; we'll tint per marker
      g.drawCircle(r, r, r)
      g.endFill()
      const tex = this.pixi.renderer.generateTexture(g, { resolution: 1, scaleMode: PIXI.SCALE_MODES.LINEAR })
      g.destroy(true)
      return tex
    },

    _getShapeTexture(shape = 'circle', aspect = 0.4) {
      this._texCache ||= {}

      // If app/renderer isn't ready, never return null — use a safe fallback
      if (!this.pixi || !this.pixi.renderer) return PIXI.Texture.WHITE

      // Renderer changed? nuke stale cache
      if (this._texCacheRenderer && this._texCacheRenderer !== this.pixi.renderer) {
        for (const t of Object.values(this._texCache)) {
          try { t && !t.destroyed && t.destroy(true) } catch {}
        }
        this._texCache = {}
      }
      this._texCacheRenderer = this.pixi.renderer

      const key = `${shape}:${aspect}`
      let tex = this._texCache[key]

      // Guard against destroyed/invalid textures
      if (tex && (tex.destroyed || (tex.baseTexture && tex.baseTexture.destroyed))) {
        tex = null
        delete this._texCache[key]
      }

      if (!tex) {
        if (shape === 'triangle') tex = this._makeTriangleTexture(256)
        else if (shape === 'square') tex = this._makeSquareTexture(256)
        else if (shape === 'squareOutline') tex = this._makeSquareOutlineTexture(256)
        else if (shape === 'flatSquare') tex = this._makeRectTexture(256, aspect)
        else tex = this._makeCircleTexture(256)
        this._texCache[key] = tex || PIXI.Texture.WHITE
      }

      return this._texCache[key] || PIXI.Texture.WHITE
    },

    _markerSpecForBody(body) {
      const type = toNumber(body.BodyTypeID, 0)
      if (type === 1) {
        return {
          shape: 'square',
          aspect: 1,
          rotation: Math.PI / 4,
          texture: this._getShapeTexture('square'),
        }
      }

      if (type === 14) {
        return {
          shape: 'triangle',
          aspect: 1,
          rotation: Math.PI,
          texture: this._getShapeTexture('triangle'),
        }
      }

      // Everything else → circle (what you had)
      return {
        shape: 'circle',
        aspect: 1,
        rotation: 0,
        texture: this._getShapeTexture('circle'),
      }
    },

    // --- WORLD MARKERS -------------------------------------------------------
    _buildMarkerWorldTree(padding = 64) {
      if (!this.viewport || !this._annotationRegistry) return null

      // Compute world bounds of all markers (small boxes around center points)
      const bounds = this._boundsInit()
      const boxes = []

      for (const entry of this._annotationRegistry) {
        if (!entry?.anchor || !entry?.orbitContainer) continue

        // marker center in STAGE px
        const gp = entry.orbitContainer.toGlobal(entry.anchor.position || { x: 0, y: 0 })
        // center in WORLD px
        const cw = this.viewport.toWorld(gp.x, gp.y)

        const hw = 10
        const hh = 10 // 20x20 hit box around the marker
        const x = cw.x - hw
        const y = cw.y - hh
        const w = hw * 2
        const h = hh * 2

        boxes.push({ x, y, width: w, height: h, entry })
        this._boundsExpandRect(bounds, x, y, x + w, y + h)
      }

      if (!Number.isFinite(bounds.xMin)) return null

      // pad & build quadtree with non-zero origin (important!)
      bounds.xMin -= padding
      bounds.yMin -= padding
      bounds.xMax += padding
      bounds.yMax += padding

      const qt = new Quadtree({
        x: bounds.xMin,
        y: bounds.yMin,
        width: bounds.xMax - bounds.xMin,
        height: bounds.yMax - bounds.yMin,
        maxDepth: 8,
        maxChildren: 10,
      })

      for (const b of boxes) qt.insert(b)

      this._markerWorldTree = qt
      return qt
    },

    // --- WORLD ORBITS --------------------------------------------------------
    _buildOrbitWorldTree(padding = 64) {
      if (!this.viewport || !this._orbitRegistry) return null

      const bounds = this._boundsInit()
      const items = []

      for (const g of this._orbitRegistry) {
        const m = g && g._orbitMeta
        if (!m) continue
        // Ensure AABB exists
        const aabb = m.aabbWorld || (this._cacheOrbitAABB(g), m.aabbWorld)
        if (!aabb) continue

        const x = aabb.xMin
        const y = aabb.yMin
        const w = aabb.xMax - aabb.xMin
        const h = aabb.yMax - aabb.yMin

        items.push({ x, y, width: w, height: h, g })
        this._boundsExpandRect(bounds, x, y, x + w, y + h)
      }

      if (!Number.isFinite(bounds.xMin)) return null

      bounds.xMin -= padding
      bounds.yMin -= padding
      bounds.xMax += padding
      bounds.yMax += padding

      const qt = new Quadtree({
        x: bounds.xMin,
        y: bounds.yMin,
        width: bounds.xMax - bounds.xMin,
        height: bounds.yMax - bounds.yMin,
        maxDepth: 8,
        maxChildren: 10,
      })

      for (const it of items) qt.insert(it)

      this._orbitWorldTree = qt
      return qt
    },

    _annotationPriority(bodyTypeId) {
      switch (bodyTypeId) {
        case 0:
          return 1000 // stars highest
        case 5:
          return 900 // Super Jovian
        case 4:
          return 800 // Gas Giant
        case 2:
          return 600 // Terrestrial Planet
        case 550:
          return 550 // Custom: Jump Point
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
      // getBounds() returns global (stage) coordinates in Pixi v6
      const b = label.getBounds()
      return { x: b.x, y: b.y, w: b.width, h: b.height }
    },

    _rectsOverlap(a, b) {
      return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)
    },

    // The on-screen radius of the marker disc
    _effectiveScreenRadius(entry) {
      const s = this.viewport?.scale?.x || 1
      const meta = entry?.marker?._bodyMeta
      if (!meta) return 0

      // If anisotropic, use the larger half-size.
      const halfW = meta.physHalfWWorld ?? meta.physWorldR ?? 0
      const halfH = meta.physHalfHWorld ?? meta.physWorldR ?? 0
      const maxHalf = Math.max(halfW, halfH)

      const minScreenR = entry.minBodyRadius ?? meta.minScreenR ?? 0
      return Math.max(maxHalf * s, minScreenR)
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
      const rect = { x: visible.xMin, y: visible.yMin, width: visible.xMax - visible.xMin, height: visible.yMax - visible.yMin }
      const MIN_ORBIT_SCREEN_R = 1.5

      // Determine which orbits intersect view via quadtree (fallback to full list)
      let toProcess
      if (this._orbitWorldTree) {
        const hits = this._orbitWorldTree.retrieve(rect)
        const set = new Set()
        toProcess = []
        for (const h of hits) {
          const g = h.g
          if (g && !set.has(g)) {
            set.add(g)
            toProcess.push(g)
          }
        }
        // Hide everything else quickly
        for (const g of this._orbitRegistry) g.renderable = set.has(g)
      } else {
        toProcess = this._orbitRegistry
      }

      for (const g of toProcess) {
        const m = g._orbitMeta
        if (!m) continue

        // LOD: small radii
        const radiusWorld = m.radiusWorld ?? (m.isCircle ? m.r : Math.max(m.ax, m.by))
        const radiusScreen = radiusWorld * s
        if (radiusScreen < MIN_ORBIT_SCREEN_R) {
          g.renderable = false
          continue
        }

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

    redrawPhysicalBodyMarkers() {
      if (!this._annotationRegistry || !this.viewport) return

      const s = this.viewport.scale?.x || 1
      const visible = this._getVisibleWorldRect(64)
      const query = { x: visible.xMin, y: visible.yMin, width: visible.xMax - visible.xMin, height: visible.yMax - visible.yMin }

      // Process only markers that intersect the viewport (fallback to all if no tree)
      let entries
      if (this._markerWorldTree) {
        const hits = this._markerWorldTree.retrieve(query)
        const seen = new Set()
        entries = []
        for (const h of hits) {
          const e = h.entry
          if (e && !seen.has(e)) {
            seen.add(e)
            entries.push(e)
          }
        }
      } else {
        entries = this._annotationRegistry
      }

      const EPS = 1e-3

      for (const entry of entries) {
        const marker = entry?.marker
        const meta = marker && marker._bodyMeta
        if (!marker || !meta || !meta.isPhysical) continue

        const physWorldR = meta.physWorldR || 0
        const minScreenR = entry.minBodyRadius ?? meta.minScreenR ?? 0

        const s = this.viewport.scale?.x || 1
        const physScreenR = physWorldR * s

        // Extra scale needed to satisfy the minimum on-screen radius.
        const clampScale = minScreenR > 0 && physScreenR > 0 ? Math.max(1, minScreenR / physScreenR) : 1

        // Preserve the sprite's base scale (physical world size) if present.
        const baseX = meta.baseScaleX ?? 1
        const baseY = meta.baseScaleY ?? baseX

        const sx = baseX * clampScale
        const sy = baseY * clampScale

        if (!approximatelyEquals(marker.scale.x, sx, EPS) || !approximatelyEquals(marker.scale.y, sy, EPS)) {
          marker.scale.set(sx, sy)
          meta.lastClampScale = clampScale
        }
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
      if (!entry || !entry.anchor) return false
      const gp = entry.orbitContainer.toGlobal(entry.anchor.position || { x: 0, y: 0 })
      const markerPosition = this.viewport.toWorld(gp.x, gp.y)
      if (!markerPosition) return false

      if (markerPosition.x < rect.xMin || markerPosition.x > rect.xMax) return false
      if (markerPosition.y < rect.yMin || markerPosition.y > rect.yMax) return false

      return true
    },

    refreshVisibleAnnotations() {
      if (!this._annotationRegistry || !this.viewport) return

      // world visible rect + small pad
      const vw = this._getVisibleWorldRect(64)
      const queryRect = { x: vw.xMin, y: vw.yMin, width: vw.xMax - vw.xMin, height: vw.yMax - vw.yMin }

      // narrow to only markers in view
      let entriesInView
      if (this._markerWorldTree) {
        const hits = this._markerWorldTree.retrieve(queryRect)
        // dedupe (quadtree may return duplicates across nodes)
        const seen = new Set()
        entriesInView = []
        for (const h of hits) {
          const e = h.entry
          if (e && !seen.has(e)) {
            seen.add(e)
            entriesInView.push(e)
          }
        }
      } else {
        entriesInView = this._annotationRegistry
      }

      const candidates = []

      // Place labels + mark markers visible for entries in view
      for (const entry of entriesInView) {
        // if (entry.marker) entry.marker.renderable = true
        if (entry.label) {
          this._placeLabel(entry)
          candidates.push({ entry, priority: this._annotationPriority(entry.bodyTypeId) })
        }
      }

      // Resolve label overlaps with a SCREEN-Space quadtree
      if (candidates.length) {
        candidates.sort((a, b) => b.priority - a.priority)

        const screenQT = new Quadtree({
          x: 0,
          y: 0,
          width: this.pixi.view.width,
          height: this.pixi.view.height,
          maxDepth: 6,
          maxChildren: 6,
        })

        for (const c of candidates) {
          const r = this._labelScreenRect(c.entry.label) // stage coords
          const probe = { x: r.x, y: r.y, width: r.w, height: r.h }
          const near = screenQT.retrieve(probe)

          let overlaps = false
          for (const n of near) {
            // n has width/height keys (not w/h)
            if (this._rectsOverlap({ x: r.x, y: r.y, w: r.w, h: r.h }, { x: n.x, y: n.y, w: n.width, h: n.height })) {
              overlaps = true
              break
            }
          }

          c.entry.label.renderable = !overlaps
          if (!overlaps) screenQT.insert(probe)
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

    // Place label using a screen-aligned offset: 'E', 'S', 'W', 'N' (we'll use E for bodies, S for stars)
    _placeLabel(entry) {
      const label = entry?.label
      const anchor = entry?.anchor
      const oc = entry?.orbitContainer
      if (!label || !anchor || !oc || !this.viewport) return

      const padPx = entry.labelPadPx ?? 8
      const effRpx = this._effectiveScreenRadius(entry)
      const offset = effRpx + padPx

      // Choose a consistent side
      const side = 'E' // entry.bodyTypeId === 0 ? 'S' : 'E' // stars below, bodies to the right

      // Marker global (stage) position
      const g = oc.toGlobal(anchor.position || { x: 0, y: 0 })
      let tx = g.x
      let ty = g.y
      if (side === 'E') tx += offset
      else if (side === 'W') tx -= offset
      else if (side === 'S') ty += offset
      else if (side === 'N') ty -= offset

      // Convert STAGE → WORLD (viewport) coords, because labelLayer is a child of viewport
      const world = this.viewport.toWorld(tx, ty)
      if (!approximatelyEquals(label.x, world.x, 1e-3) || !approximatelyEquals(label.y, world.y, 1e-3)) {
        label.position.set(world.x, world.y)
      }

      // Keep text upright and constant size on screen
      const s = this.viewport.scale?.x || 1
      const invS = 1 / s
      if (!approximatelyEquals(label.scale?.x, invS, 1e-3) || !approximatelyEquals(label.scale?.y, invS, 1e-3)) {
        label.scale.set(invS, invS)
      }
      if (!approximatelyEquals(label.rotation, 0, 1e-6)) {
        label.rotation = 0
      }
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
    computeSceneBounds(paddingScreenPx = 64, { includeLabels = true, includeMarkers = true, assumeScale = null } = {}) {
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
          const anchor = entry?.anchor
          if (!anchor) continue
          const marker = entry?.marker
          if (!marker) continue
          const meta = marker._bodyMeta
          if (!meta || !meta.isPhysical) continue

          // center in world
          const oc = entry.orbitContainer
          if (!oc) continue
          const gp = oc.toGlobal(anchor.position || { x: 0, y: 0 }) // stage px
          const cw = toWorld(gp.x, gp.y) // world px

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
          const cw = toWorld(gp.x, gp.y) // world px

          const wpx = label._baseWpx ?? label.width ?? 0
          const hpx = label._baseHpx ?? label.height ?? 0
          const halfW = wpx * 0.5 * invSTarget
          const halfH = hpx * 0.5 * invSTarget

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

    getPrimaryStarWorldCenter() {
      const sr = this._starsResult
      if (!sr) return null

      // Prefer Component 1; fallback to any with OrbitingComponent===0; else first
      const primary = (sr.byComponent && (sr.byComponent[1] || sr.byComponent['1'])) || Object.values(sr.byComponent || {}).find((e) => toNumber(e.star?.OrbitingComponent, 0) === 0) || Object.values(sr.byComponent || {})[0]

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

    drawSystem(system, stars, { origin = { x: this.pixi.view.width / 2, y: this.pixi.view.height / 2 }, orbitStyle = { color: 0x6aa7ff, alpha: 0.45, width: 1 }, starSize = { exaggeration: 1, minPx: 0, maxPx: 1e7 }, minStarRadius = 6, labelPadPx = 8, markerProvider = null } = {}) {
      const root = new PIXI.Container()
      root.position.set(toNumber(origin.x), toNumber(origin.y))
      this.worldLayer.addChild(root)

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
            parentLocal = parentDrawn.anchor.position // orbit about the parent's current position
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
        const { orbitContainer, anchor, marker } = this.drawOrbit(bodyLike, {
          parentContainer,
          position: parentLocal,
          orbitLine: true,
          keepLabelUpright: true,
          style: { color, alpha: orbitStyle.alpha, width: orbitStyle.width },
          parentWorldXkm,
          parentWorldYkm,
          computedBodyPixelRadius: radiusPx,
          minBodyRadius: minStarRadius ?? 6,
          markerProvider,
          deferredRegistration: true,
        })

        if (marker && marker._bodyMeta) {
          marker._bodyMeta.fill = color
          if (marker.tint !== undefined) {
            marker.tint = color // Sprite path
          } else if (marker.clear) {
            // Graphics fallback
            marker.clear()
            marker.beginFill(color, 1)
            marker.drawCircle(0, 0, marker._bodyMeta.physWorldR)
            marker.endFill()
          }
        }

        // Label for star (bigger, always shown)
        const labelText = starName(index, system)
        const starLabel = new PIXI.Text(labelText, TEXT_STYLES.star)
        starLabel.anchor.set(0, 0.5)
        // starLabel.position.set(anchor.position.x + radiusPx + labelPadPx, anchor.position.y)
        starLabel._baseWpx = starLabel.width
        starLabel._baseHpx = starLabel.height
        const desired = -getWorldRotation(orbitContainer)
        if (!approximatelyEquals(starLabel.rotation, desired, 1e-6)) starLabel.rotation = desired

        this.labelLayer.addChild(starLabel)

        // register star label & marker for visibility-based refresh & constant-size scaling
        if (this._annotationRegistry && Array.isArray(this._annotationRegistry)) {
          this._annotationRegistry.push({
            orbitContainer,
            anchor,
            marker,
            label: starLabel,
            keepLabelUpright: true,
            bodyTypeId: 0, // star
            labelPadPx: 6,
            starRadiusPx: radiusPx,
          })
        }

        drawnByComponent.set(comp, { orbitContainer, anchor, marker, star })
        byStarID.set(toNumber(star.StarID), { orbitContainer, anchor, marker, star })
      }

      return { root, byStarID: Object.fromEntries(byStarID), byComponent: Object.fromEntries(drawnByComponent) }
    },

    drawBodiesForSystem(bodies, { style = { color: 0x32cd32, alpha: 1, width: 2 }, sizeOpts = { radiusUnits: 'km', exaggeration: 1 }, keepLabelUpright = true, labelPadPx = 8, minBodyRadius = 4, markerProvider = null } = {}) {
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
        const starRef = this._starsResult.byStarID[String(sid)] || this._starsResult.byStarID[sid]

        // choose parent anchor
        let parentContainer = this._starsResult.root
        let parentLocalPos = { x: 0, y: 0 }
        let parentWorldXkm, parentWorldYkm

        const parentBodyId = toNumber(body.ParentBodyID, 0)
        if (parentBodyId && drawnByBodyId.has(parentBodyId)) {
          const parentDrawn = drawnByBodyId.get(parentBodyId)
          parentContainer = parentDrawn.orbitContainer
          parentLocalPos = parentDrawn.anchor.position
          parentWorldXkm = toNumber(parentDrawn.body.Xcor, NaN)
          parentWorldYkm = toNumber(parentDrawn.body.Ycor, NaN)
        } else if (starRef) {
          parentContainer = starRef.orbitContainer
          parentLocalPos = starRef.anchor.position
          parentWorldXkm = starRef.star && toNumber(starRef.star.Xcor, NaN)
          parentWorldYkm = starRef.star && toNumber(starRef.star.Ycor, NaN)
        }

        const rPx = Math.max(bodyPixelRadius(body, sizeOpts), 0)
        const r = this.drawOrbit(body, {
          parentContainer,
          position: parentLocalPos,
          orbitLine: isRenderOrbitBodyType(body.BodyTypeID),
          keepLabelUpright,
          nameText: systemBodyName(body),
          style,
          parentWorldXkm,
          parentWorldYkm,
          labelPadPx,
          computedBodyPixelRadius: rPx,
          minBodyRadius,
          markerProvider,
        })

        drawnByBodyId.set(toNumber(body.SystemBodyID, -1), { ...r, body })
        out.push(r)
      }

      return out
    },

    drawOrbit(bodyLike, { parentContainer = this.worldLayer, position = { x: 0, y: 0 }, style = { color: 0x8aa1ff, alpha: 0.55, width: 2 }, orbitLine = true, keepLabelUpright = true, nameText = undefined, parentWorldXkm = undefined, parentWorldYkm = undefined, computedBodyPixelRadius = null, minBodyRadius = 3, labelPadPx = 8, markerProvider = null, deferredRegistration = false } = {}) {
      const orbitContainer = new PIXI.Container()
      orbitContainer.position.set(toNumber(position.x), toNumber(position.y))
      orbitContainer.cullable = true

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
      const pxkm = toNumber(parentWorldXkm, NaN)
      const pykm = toNumber(parentWorldYkm, NaN)

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

        if (orbitLine && aRaw > 0) {
          const g = new PIXI.Graphics()
          const w = style.width ?? 1
          g.lineStyle(w, style.color ?? 0x8aa1ff, style.alpha ?? 0.55)
          g.drawCircle(0, 0, ax)
          g.cullable = true
          g._orbitMeta = {
            baseWidth: w,
            color: style.color ?? 0x8aa1ff,
            alpha: style.alpha ?? 0.55,
            isCircle: true,
            r: ax,
            lastDrawnWidth: null,
          }

          if (this._orbitRegistry && Array.isArray(this._orbitRegistry)) {
            this._orbitRegistry.push(g)
          }

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

        if (orbitLine && (ax > 0 || by > 0)) {
          const g = new PIXI.Graphics()
          const w = style.width ?? 1
          g.lineStyle(w, style.color ?? 0x8aa1ff, style.alpha ?? 0.55)
          g.drawEllipse(cxSigned, 0, ax, by)
          g.cullable = true
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

          if (this._orbitRegistry && Array.isArray(this._orbitRegistry)) this._orbitRegistry.push(g)
          orbitContainer.addChild(g)
        }
      }

      // ---- Body marker (physical world radius; redraw on zoom for min-screen clamp)
      const physR = Math.max(1e-6, toNumber(computedBodyPixelRadius, 0)) // avoid 0 for scale math
      const { fill: markerColor } = pickBodyColor(bodyLike)

      let marker
      if (markerProvider) {
        const spec = markerProvider(bodyLike)
        const aspect = Math.max(1e-6, spec?.aspect ?? 1)

        marker = new PIXI.Sprite(spec.texture)
        marker.anchor.set(0.5)

        // Physical size in WORLD units. Non-circles get independent width/height.
        const widthWorld = Math.max(physR * 2, 1e-6 * 2)
        const heightWorld = Math.max(widthWorld * aspect, 1e-6 * 2)
        marker.width = widthWorld
        marker.height = heightWorld

        // Rotate for “diamond” asteroids
        if (spec.rotation) marker.rotation = spec.rotation

        marker.tint = markerColor

        // Save base scale so the min-screen clamp multiplies instead of overwriting.
        const baseScaleX = marker.scale.x
        const baseScaleY = marker.scale.y

        marker._bodyMeta = {
          isPhysical: true,
          physWorldR: physR, // keep for logic that assumes a radius
          // also store anisotropic half-sizes so label offset can respect the bigger axis
          physHalfWWorld: widthWorld * 0.5,
          physHalfHWorld: heightWorld * 0.5,
          minScreenR: Math.max(0, toNumber(minBodyRadius, 0)),
          fill: markerColor,
          baseScaleX,
          baseScaleY,
          lastClampScale: 1,
        }
      } else {
        marker = new PIXI.Graphics()

        // initial draw at the physical world radius; stroke will be normalized on first zoom refresh
        // marker.lineStyle(1, 0x000000, 1)
        marker.beginFill(markerColor, 1)
        marker.drawCircle(0, 0, physR)
        marker.endFill()

        // metadata to drive redraw-on-zoom (scale stays = 1 always)
        marker._bodyMeta = {
          isPhysical: true,
          physWorldR: physR, // world px
          minScreenR: Math.max(0, toNumber(minBodyRadius, 0)), // px on screen
          fill: markerColor,
          // stroke: 0x000000,
          // strokeAlpha: 1,
          lastDrawnWorldR: -1,
          lastScale: 1,
        }
      }

      parentContainer.addChild(orbitContainer)

      // Interactivity
      marker.interactive = true
      marker.on('pointerdown', (e, ...asd) => {
        const xy = this.viewport.toWorld(e.data.global.x, e.data.global.y)
        this.viewport.snap(xy.x, xy.y, { time: 300, removeOnComplete: true })
      })

      // Position & Anchor
      const anchor = new PIXI.Container()

      if (Number.isFinite(localX) && Number.isFinite(localY)) {
        anchor.position.set(localX, localY)
      } else {
        // Final fallback (unit-correct now)
        const bearingDeg = safeModulo360(toNumber(bodyLike.Bearing, 0))
        const nu = (bearingDeg - 90) * DEG2RAD
        const rPx = circleMode ? ax : (ax * (1 - e * e)) / (1 + e * Math.cos(nu))
        anchor.position.set(rPx * Math.cos(nu), rPx * Math.sin(nu))
      }

      orbitContainer.addChild(anchor)

      const gp = orbitContainer.toGlobal(anchor.position)
      const wp = this.viewport.toWorld(gp.x, gp.y)

      marker.position.set(wp.x, wp.y)
      marker.zIndex = this._annotationPriority(bodyLike.BodyTypeID)

      this.markerLayer.addChild(marker)

      // Label
      let label = null
      if (nameText) {
        label = new PIXI.Text(String(nameText), TEXT_STYLES.body)
        label.anchor.set(0, 0.5)
        // label.position.set(marker.x + (labelPadPx ?? 8), marker.y)
        label._baseWpx = label.width
        label._baseHpx = label.height
        label.cullable = true

        this.labelLayer.addChild(label)
      }

      // Now adjust label rotation accurately using WORLD rotation, but only if needed
      if (label) {
        const desired = keepLabelUpright ? -getWorldRotation(orbitContainer) : -getWorldRotation(parentContainer)
        if (!approximatelyEquals(label.rotation, desired, 1e-6)) label.rotation = desired
      }

      if (!deferredRegistration && this._annotationRegistry && Array.isArray(this._annotationRegistry)) {
        this._annotationRegistry.push({
          orbitContainer,
          anchor,
          marker,
          label,
          keepLabelUpright: !!keepLabelUpright,
          bodyTypeId: bodyLike.BodyTypeID,
          labelPadPx: labelPadPx ?? 8,

          isPhysicalSizeBody: true,
          computedBodyPixelRadius: physR, // world px
          minBodyRadius: Math.max(0, toNumber(minBodyRadius, 0)), // screen px
        })
      }

      return { orbitContainer, anchor, marker }
    },

    drawJumpPoints(jumpPoints, {
      minMarkerRadius = 6,          // px on screen
      labelPadPx = 8,               // screen px
    } = {}) {
      if (!Array.isArray(jumpPoints) || !this._starsResult) return

      const orbitContainer = this._starsResult.root      // use the same root as stars
      const circleTex = this._getShapeTexture('circle')
      const squareOutlineTex = this._getShapeTexture('squareOutline')

      const COLOR_RED = 0xff3b30
      const COLOR_ORANGE = 0xffa500

      // tiny physical size; min-screen clamp makes it visible
      const physR = 1e-6

      for (const jp of jumpPoints) {
        const xkm = toNumber(jp.Xcor, 0)
        const ykm = toNumber(jp.Ycor, 0)

        // local offset from system origin in **world px**
        const localX = unitsToPx(xkm / AU_KM)
        const localY = unitsToPx(ykm / AU_KM)

        // anchor lives under the same root as stars, so all transforms match
        const anchor = new PIXI.Container()
        anchor.position.set(localX, localY)
        orbitContainer.addChild(anchor)

        // convert to viewport WORLD coords for the marker layer
        const gp = orbitContainer.toGlobal(anchor.position)
        const wp = this.viewport.toWorld(gp.x, gp.y)

        const explored = toNumber(jp.Explored, 0) === 1
        const hasGate = toNumber(jp.JumpGateStrength, 0) >= 1000
        const tint = explored ? COLOR_ORANGE : COLOR_RED

        // marker is a Container so we can stack shapes
        const marker = new PIXI.Container()
        marker.position.set(wp.x, wp.y)

        // circle core
        const core = new PIXI.Sprite(circleTex)
        core.anchor.set(0.5)
        const diameter = Math.max(physR * 2, 1e-6 * 2)
        core.width = core.height = diameter
        core.tint = tint
        marker.addChild(core)

        // optional square outline (gate present)
        if (hasGate) {
          const box = new PIXI.Sprite(squareOutlineTex)
          box.anchor.set(0.5)
          // a little larger than the circle core
          box.width = box.height = diameter * 1.6
          box.tint = tint
          marker.addChild(box)
        }

        // metadata → min-screen clamping uses this
        marker._bodyMeta = {
          isPhysical: true,
          physWorldR: physR,
          minScreenR: Math.max(0, toNumber(minMarkerRadius, 0)),
          fill: tint,
          baseScaleX: 1,
          baseScaleY: 1,
          lastClampScale: 1,
        }

        // interactivity: tap to center/zoom like other markers
        marker.interactive = true
        marker.on('pointerdown', (e) => {
          const xy = this.viewport.toWorld(e.data.global.x, e.data.global.y)
          this.viewport.snap(xy.x, xy.y, { time: 300, removeOnComplete: true })
        })

        // draw order: above most bodies, below labels
        marker.zIndex = this._annotationPriority(550) // Custom: 550
        this.markerLayer.addChild(marker)

        // label (optional; uses Name if present)
        let label = null
        const labelText = (jp.DestinationName && String(jp.DestinationName).trim()) || 'Jump Point'
        label = new PIXI.Text(labelText, TEXT_STYLES.body)
        label.anchor.set(0, 0.5)
        label._baseWpx = label.width
        label._baseHpx = label.height
        label.cullable = true
        this.labelLayer.addChild(label)

        // register for placement/visibility + LOD scaling
        this._annotationRegistry.push({
          orbitContainer,
          anchor,
          marker,
          label,
          keepLabelUpright: true,
          bodyTypeId: 550, // Custom: 550
          labelPadPx,
          minBodyRadius: Math.max(0, toNumber(minMarkerRadius, 0)),
        })
      }
    },

    scheduleInitPixi() {
      if (this._initRaf) cancelAnimationFrame(this._initRaf)
      this._initRaf = requestAnimationFrame(() => {
        this._initRaf = null

        if (!this.elements.system) return
        if (!Array.isArray(this.elements.stars) || this.elements.stars.length === 0) return

        this.initPixi()
      })
    },

    initPixi() {
      if (!this.elements.system) {
        console.warn('initPixi: system not loaded yet')
        return
      }

      if (!Array.isArray(this.elements.stars) || this.elements.stars.length === 0) {
        console.warn('initPixi: stars not loaded yet')
        return
      }

      if (this.pixi) {
        if (this._texCache) {
          for (const k of Object.keys(this._texCache)) {
            try {
              this._texCache[k].destroy(true)
            } catch (e) {}
          }
          this._texCache = {}
        }

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

      this._orbitRegistry = []
      this._annotationRegistry = []

      this.worldLayer = new PIXI.Container()
      this.markerLayer = new PIXI.Container()
      this.labelLayer = new PIXI.Container()

      this.viewport.sortableChildren = true
      this.markerLayer.sortableChildren = true

      this.worldLayer.zIndex = 0
      this.markerLayer.zIndex = 500
      this.labelLayer.zIndex = 1000

      this.viewport.addChild(this.worldLayer)
      this.viewport.addChild(this.markerLayer)
      this.viewport.addChild(this.labelLayer)

      this._starsResult = this.drawSystem(this.elements.system, this.elements.stars, {
        origin: { x: this.pixi.view.width / 2, y: this.pixi.view.height / 2 },
        orbitStyle: { color: 0x00ff00, alpha: 1, width: 1 },
        starSize: { exaggeration: 1, minPx: 0, maxPx: 1e7 },
        minStarRadius: 8,
        markerProvider: this._markerSpecForBody,
      })

      this.drawBodiesForSystem(this.elements.systemBodies, {
        style: { color: 0x32cd32, alpha: 1, width: 2 },
        sizeOpts: {
          // choose what you prefer:
          // radiusUnits: 'km', exaggeration: 1,  minPx: 0,    // strict physical realism
          radiusUnits: 'km',
          exaggeration: 1,
          // radiusUnits: 'km', exaggeration: 500, minPx: 0.5, // gently magnified for readability
          // radiusUnits: 'earthRadii', exaggeration: 1, minPx: 0.5, // if Radius is in R⊕
        },
        keepLabelUpright: true,
        labelPadPx: 8,
        minBodyRadius: 5,
        markerProvider: this._markerSpecForBody,
      })

      if (Array.isArray(this.elements.jumpPoints) && this.elements.jumpPoints.length) {
        this.drawJumpPoints(this.elements.jumpPoints, {
          minMarkerRadius: 4,
          labelPadPx: 6,
        })
      }

      this._cacheAllOrbitAABBs()

      this._buildMarkerWorldTree()
      this._buildOrbitWorldTree()

      const update = () => {
        this.refreshVisibleAnnotations()

        this.redrawOrbitStrokes()
        this.redrawPhysicalBodyMarkers()
      }

      this.viewport.addListener('moved', update)
      this.viewport.addListener('zoomed', update)
      this.viewport.addListener('pinch', update)

      this.fitToContent()
    },
  },
  asyncComputed: {
    elements: {
      async get() {
        if (!this.database || !this.RaceID) {
          return {}
        }

        const system = await this.database.models.RaceSystemSurvey.findOne({
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

        if (!system) {
          return {}
        }

        const stars = await this.database.models.Star.findAll({
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

        if (!stars || !stars.length) {
          return {}
        }

        const systemBodies = await this.database.models.SystemBody.findAll({
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

        const jumpPoints = await this.database.query(`
          select FCT_JumpPoint.*, FCT_RaceSysSurvey.Name as SourceName, VIR_Destination.SystemID as DestinationID, VIR_Destination.Name as DestinationName, FCT_RaceJumpPointSurvey.Explored, FCT_RaceJumpPointSurvey.Charted, FCT_RaceJumpPointSurvey.Hide from FCT_JumpPoint 
          
          inner join FCT_RaceSysSurvey on FCT_JumpPoint.SystemID = FCT_RaceSysSurvey.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} 
          left join (
            select * from FCT_JumpPoint
            left join FCT_RaceSysSurvey on FCT_JumpPoint.SystemID = FCT_RaceSysSurvey.SystemID and FCT_RaceSysSurvey.RaceID = 779 and FCT_RaceSysSurvey.GameID = 139 
          ) as VIR_Destination on FCT_JumpPoint.WPLink = VIR_Destination.WarpPointID 
          left join FCT_Race on FCT_JumpPoint.GameID = FCT_Race.GameID 
          left join FCT_RaceJumpPointSurvey on FCT_JumpPoint.WarpPointID = FCT_RaceJumpPointSurvey.WarpPointID and FCT_Race.RaceID = FCT_RaceJumpPointSurvey.RaceID
          
          where FCT_JumpPoint.SystemID = ${this.$props.systemId} and FCT_JumpPoint.GameID = ${this.GameID} and FCT_Race.RaceID = ${this.RaceID} and FCT_RaceJumpPointSurvey.Charted = 1
        `).then(([items]) => {
          console.log('Loaded jump points:', items)
          return items
        })

        return {
          system: system.toJSON(),
          stars: stars.map((s) => s.toJSON()),
          systemBodies,
          jumpPoints,
        }
      },
      default: {},
    },
  },
}
</script>

<style scoped></style>
