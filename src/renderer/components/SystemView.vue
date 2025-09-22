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

import { clamp as _clamp } from 'lodash'

import { Viewport } from 'pixi-viewport'
import { mapGetters } from 'vuex'
import { starName, systemBodyName, toNumber } from '~/utilities/aurora'

PIXI.settings.ROUND_PIXELS = true

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
const planetaryBodyTypeIds = new Set([2, 3, 4, 5])

const unitsToPx = (u) => u * 150

const DEG2RAD = Math.PI / 180
const AU_KM = 149597870.7

// Star pixel radius from luminosity (L≈1 → readable, caps to avoid galaxy-sized suns)
const starPixelRadius = (star, sizeOpts = {}) => {
  const {
    sizeMode = 'luminosity', // "luminosity" | "fixed"
    fixedPx = 8,
    minPx = 4,
    maxPx = 22,
    scale = 5, // used in luminosity mode
  } = sizeOpts
  if (sizeMode === 'fixed') return _clamp(fixedPx, minPx, maxPx)
  const L = Math.max(0, toNumber(star.Luminosity, 1)) // assume L in L☉
  // Rough but nice-looking: Rpx ∝ sqrt(L)
  return _clamp(minPx + Math.sqrt(L) * scale, minPx, maxPx)
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

const drawOrbitLocal = (parentContainer, position, bodyLike, style = { color: 0x8aa1ff, alpha: 0.55, width: 2 }, opts = { orbitLine: true, keepLabelUpright: true, registry: [] }) => {
  const orbitContainer = new PIXI.Container()
  orbitContainer.position.set(toNumber(position.x), toNumber(position.y))

  const a = Math.max(0, toNumber(bodyLike.OrbitalDistance, 0))
  let e = _clamp(toNumber(bodyLike.Eccentricity, 0), 0, 0.999)
  if ((!e || e <= 0) && Number.isFinite(toNumber(bodyLike.DistanceToOrbitCentre))) {
    const cWorld = Math.max(0, toNumber(bodyLike.DistanceToOrbitCentre, 0))
    if (a > 0) e = _clamp(cWorld / a, 0, 0.999)
  }

  const b = a * Math.sqrt(1 - e * e)
  const c = a * e

  // Orientation of the apse line
  const phiDeg = toNumber(bodyLike.EccentricityDirection, 0) // - 90 // uncomment if DB stores compass bearings
  const phi = phiDeg * DEG2RAD

  // Optional exact DB position (km). If parentWorld* are provided we convert to relative.
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

  const ax = unitsToPx(a)
  const by = unitsToPx(b)
  const cx = unitsToPx(c)

  // Ensure world orientation is φ even under a rotated parent
  const parentRot = parentContainer.rotation || 0
  orbitContainer.rotation = phi - parentRot

  // Choose which focus (left/right) the barycenter should be.
  // Rotate the world vector into the orbit-aligned frame and see
  // whether centerX = +c or -c better satisfies the ellipse equation.
  let centerSign = 1
  let localX, localY
  if (Number.isFinite(dxPx) && Number.isFinite(dyPx) && (dxPx !== 0 || dyPx !== 0)) {
    const cosφ = Math.cos(phi)
    const sinφ = Math.sin(phi)
    localX = dxPx * cosφ + dyPx * sinφ
    localY = -dxPx * sinφ + dyPx * cosφ

    const err = (cxSign) => {
      const u = localX - cxSign * cx
      const v = localY
      // ((x - cx)^2 / a^2) + (y^2 / b^2) ≈ 1
      return Math.abs((u * u) / (ax * ax) + (v * v) / (by * by) - 1)
    }

    const errPlus = err(+1)
    const errMinus = err(-1)
    if (errMinus < errPlus) centerSign = -1
  }

  const cxSigned = centerSign * cx

  if (opts.orbitLine) {
    const g = new PIXI.Graphics()
    g.lineStyle(style.width ?? 1, style.color ?? 0x8aa1ff, style.alpha ?? 0.55)
    g.drawEllipse(cxSigned, 0, ax, by)

    // store metadata so stroke width can be kept constant on zoom
    g._orbitMeta = {
      baseWidth: style.width ?? 1,
      color: style.color ?? 0x8aa1ff,
      alpha: style.alpha ?? 0.55,
      ax,
      by,
      cx: cxSigned, // store signed center
    }
    if (opts.registry && Array.isArray(opts.registry)) {
      opts.registry.push(g)
    }

    orbitContainer.addChild(g)
  }

  // Marker (body position)
  const marker = new PIXI.Graphics()
  marker.beginFill(0xffffff, 1).lineStyle(1, 0x000000, 0.6).drawCircle(0, 0, 3).endFill()

  if (Number.isFinite(localX) && Number.isFinite(localY)) {
    marker.position.set(localX, localY)
  } else {
    // Fallback: derive from bearing in screen space
    const bearingDegRaw = toNumber(bodyLike.Bearing, 0)
    const bearingDeg = ((bearingDegRaw % 360) + 360) % 360
    const nu = (bearingDeg - 90) * DEG2RAD
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
    if (opts.keepLabelUpright) {
      label.rotation = -parentContainer.rotation - orbitContainer.rotation
    }
    orbitContainer.addChild(label)
  }

  parentContainer.addChild(orbitContainer)
  return { orbitContainer, marker }
}

const drawSystem = (stage, system, opts = {}) => {
  const { origin = { x: 0, y: 0 }, orbitStyle = { color: 0x6aa7ff, alpha: 0.45, width: 1 }, starSize = { sizeMode: 'luminosity', minPx: 4, maxPx: 22, scale: 5 } } = opts

  const stars = system?.System?.Stars || []

  const orbitRegistry = opts.orbitRegistry || []

  const root = new PIXI.Container()
  root.position.set(toNumber(origin.x), toNumber(origin.y))
  stage.addChild(root)

  // Build index by Component and by StarID
  const byComponent = new Map()
  const byStarID = new Map()
  stars.forEach((s) => {
    byComponent.set(toNumber(s.Component, 1), s)
  })

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
  ordered.forEach((star, index) => {
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
    const color = starColorForComponent(comp)
    const sprite = drawStar(radiusPx, color)

    // Draw the star's ORBIT path and marker (its current orbital position)
    const { orbitContainer, marker } = drawOrbitLocal(
      parentContainer,
      parentLocal,
      bodyLike,
      {
        color,
        alpha: orbitStyle.alpha,
        width: orbitStyle.width,
      },
      { orbitLine: true, keepLabelUpright: true, parentWorldXkm, parentWorldYkm, registry: orbitRegistry }
    )

    // Draw the star itself at the marker
    sprite.position.copyFrom(marker.position)
    orbitContainer.addChild(sprite)

    // Label for star (bigger, always shown)
    const labelText = starName(index, system)
    const starLabelStyle = new PIXI.TextStyle({
      fill: 0xffffff,
      fontSize: 12,
      fontWeight: 'bold',
      dropShadow: true,
      dropShadowDistance: 1,
      dropShadowBlur: 0,
      dropShadowAlpha: 0.6,
    })
    const starLabel = new PIXI.Text(labelText, starLabelStyle)
    starLabel.anchor.set(0.5, 1)
    starLabel.position.set(sprite.position.x, sprite.position.y - (radiusPx + 6))
    starLabel.rotation = -((parentContainer.rotation || 0) + orbitContainer.rotation)
    orbitContainer.addChild(starLabel)

    drawnByComponent.set(comp, { orbitContainer, marker, sprite, star })
    byStarID.set(toNumber(star.StarID), { orbitContainer, marker, sprite, star })
  })

  return { root, byStarID: Object.fromEntries(byStarID), byComponent: Object.fromEntries(drawnByComponent) }
}

function drawBodyAround(parentContainer, parentLocalPos, body, style = { color: 0x8aa1ff, alpha: 0.55, width: 1 }, parentWorldXkm, parentWorldYkm, orbitRegistry = []) {
  return drawOrbitLocal(parentContainer, parentLocalPos, body, style, {
    orbitLine: planetaryBodyTypeIds.has(body.BodyTypeID), // gas giants and terrestrial planets get orbits
    keepLabelUpright: true,
    nameText: systemBodyName(body),
    parentWorldXkm,
    parentWorldYkm,
    registry: orbitRegistry,
  })
}

function drawBodiesForSystem(rootContainer, bodies, starsResult, style = { color: 0x8aa1ff, alpha: 0.55, width: 1 }, orbitRegistry = []) {
  const out = []
  for (const body of bodies) {
    const sid = toNumber(body.StarID, NaN)
    const starRef = starsResult.byStarID[String(sid)] || starsResult.byStarID[sid]
    if (!starRef) {
      // Fallback: if no star mapping, attach to root at system origin
      out.push(drawBodyAround(rootContainer, { x: 0, y: 0 }, body, style))
      continue
    }
    // Attach body orbit to the star's orbit container, centered at the star's *current* position
    out.push(drawBodyAround(starRef.orbitContainer, starRef.marker.position, body, style, starRef.star && toNumber(starRef.star.Xcor, NaN), starRef.star && toNumber(starRef.star.Ycor, NaN), orbitRegistry))
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
    return {}
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),
  },
  watch: {
    systemBodies(newBodies, _oldBodies) {
      console.log('systemBodies changed:', newBodies)
      this.initPixi()
    },
  },
  mounted() {},
  beforeDestroy() {
    if (this.pixi) {
      console.log('Destroying PIXI application??')
      this.pixi.destroy(true, true)
      this.pixi = null
    }
  },
  methods: {
    redrawOrbitStrokes() {
      if (!this._orbitRegistry || !this.viewport) return
      const s = this.viewport.scale?.x || 1
      for (const g of this._orbitRegistry) {
        const m = g._orbitMeta
        if (!m) continue
        const w = m.baseWidth / s
        g.clear()
        g.lineStyle(w, m.color, m.alpha)
        g.drawEllipse(m.cx, 0, m.ax, m.by)
      }
    },

    initPixi() {
      if (this.pixi) {
        this.pixi.destroy(true, true)
        this.pixi = null
      }

      console.log('SystemView mounted', this.$props)

      this.pixi = new PIXI.Application({
        width: window.innerWidth,
        height: window.innerHeight - 64, // Adjust for toolbar height
        backgroundColor: 0x000040,
        zIndex: 0,
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
          smooth: 10,
        })
        .decelerate()

      console.log('## systemBodies', this.systemBodies)

      this._orbitRegistry = []

      const starsResult = drawSystem(this.viewport, this.system || {}, {
        origin: { x: this.pixi.view.width / 2, y: this.pixi.view.height / 2 },
        starSize: { sizeMode: 'luminosity', minPx: 4, maxPx: 22, scale: 5 },
        orbitStyle: { color: 0x00ff00, alpha: 0.35, width: 1 },
        orbitRegistry: this._orbitRegistry,
      })

      drawBodiesForSystem(starsResult.root, this.systemBodies, starsResult, { color: 0x00ff00, alpha: 0.5, width: 2 }, this._orbitRegistry)

      // keep stroke width constant across zoom levels
      const refreshStroke = () => {
        this.redrawOrbitStrokes()
      }
      this.viewport.addListener('zoomed', refreshStroke)
      this.viewport.on('pinch', refreshStroke)

      // initial pass
      this.redrawOrbitStrokes()
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
            },
          ],
        }).then((system) => {
          console.log('Loaded system:', system.toJSON())
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
