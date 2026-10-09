// Borders round the systems of a sector or an alien race on the Galaxy Map. Linked systems of one group
// share a shape that takes in the links between them; a system or cluster cut off from the rest of its
// group gets a shape of its own.

// Room round a system's marker inside its border, the half width of the band along a link, and the
// border's line, in map units. The band is narrower than the smallest system's room, so each link
// shows as a neck between its systems.
const ROOM = 26
const BAND = 34
const LINE = 3
export const TINT = 0.14
// The group's name beside each shape, in map units. Like the systems' names, it shows once it would
// be 9 pixels tall on screen.
const LABEL_SIZE = 16
const LABEL_FONT = `500 ${LABEL_SIZE}px Roboto, sans-serif`
const LABEL_MIN_PX = 9
// Between a name and its shape's line.
const LABEL_GAP = 8
// The systems' own names, as the page's cytoscape style draws them: under the marker, 5 units down,
// in a 14 px font on a background 2 units wider all round.
const NAME_FONT = '14px Roboto, sans-serif'
const NAME_DROP = 3
const NAME_HEIGHT = 21
// Round a name's place, the room counted as crowding when choosing the freer side.
const CROWD = 40

export const showsLabels = (zoom) => LABEL_SIZE * zoom >= LABEL_MIN_PX

// The systems of each group, split where the group's own links don't join them: [{ owner, ids, links }],
// with `links` the [source, target] pairs inside the part. `ownerOf(row)` is the group (the same object
// for every system in it, with `name` and `color`), or nothing for a system outside every group.
export const groupBorders = (rows, links, ownerOf) => {
  const owners = new Map()

  rows.forEach((row) => {
    const owner = ownerOf(row)

    if (owner) {
      owners.set(row.id, owner)
    }
  })

  const parent = new Map([...owners.keys()].map((id) => [id, id]))
  const root = (id) => {
    let at = id

    while (parent.get(at) !== at) {
      parent.set(at, parent.get(parent.get(at)))
      at = parent.get(at)
    }

    return at
  }
  const inside = links.filter(({ source, target }) => owners.has(source) && owners.get(source) === owners.get(target))

  inside.forEach(({ source, target }) => parent.set(root(source), root(target)))

  const parts = new Map()

  owners.forEach((owner, id) => {
    const key = root(id)

    if (!parts.has(key)) {
      parts.set(key, { owner, ids: [], links: [] })
    }

    parts.get(key).ids.push(id)
  })
  inside.forEach(({ source, target }) => parts.get(root(source)).links.push([source, target]))

  return [...parts.values()]
}

// Adds a part's shape to `path`, grown by `grow`: a disc round each system and a band along each link.
// Every piece runs clockwise, so the nonzero fill joins them where they overlap. A system the map
// doesn't have yet (`positionOf` gives nothing) is left out.
const tracePart = (path, part, { positionOf, sizeOf }, grow) => {
  part.ids.forEach((id) => {
    const at = positionOf(id)

    if (at) {
      const radius = sizeOf(id) / 2 + ROOM + grow

      path.moveTo(at.x + radius, at.y)
      path.arc(at.x, at.y, radius, 0, 2 * Math.PI)
    }
  })

  part.links.forEach(([source, target]) => {
    const a = positionOf(source)
    const b = positionOf(target)
    const length = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0

    if (length) {
      const half = BAND + grow
      const nx = ((b.y - a.y) / length) * half
      const ny = ((a.x - b.x) / length) * half

      path.moveTo(a.x + nx, a.y + ny)
      path.lineTo(b.x + nx, b.y + ny)
      path.lineTo(b.x - nx, b.y - ny)
      path.lineTo(a.x - nx, a.y - ny)
      path.closePath()
    }
  })
}

// Draws the parts on `context`, already transformed to map units, at `zoom` screen pixels to a map unit.
// Each shape gets a line of its group's colour and a light tint inside; later shapes lie over earlier
// ones where they meet. `positionOf(id)` and `sizeOf(id)` give a system's place and marker size;
// `places`, from `placeLabels`, puts the groups' names, and none are drawn without it.
export const drawBorders = (context, parts, { positionOf, sizeOf, zoom, ink, halo, places = null }) => {
  if (!parts.length) {
    return
  }

  const where = { positionOf, sizeOf }
  // At least two pixels wide however far out the view is.
  const line = Math.max(LINE, 2 / zoom)

  parts.forEach((part) => {
    const outer = new Path2D()
    const inner = new Path2D()

    tracePart(outer, part, where, line)
    tracePart(inner, part, where, 0)

    // The shape grown by the line, its inside cut back out, then tinted: one fill each, so the tint
    // stays even where the discs and bands overlap.
    context.fillStyle = part.owner.color
    context.fill(outer)
    context.globalCompositeOperation = 'destination-out'
    context.fill(inner)
    context.globalCompositeOperation = 'source-over'
    context.globalAlpha = TINT
    context.fill(inner)
    context.globalAlpha = 1
  })

  if (!places || !showsLabels(zoom)) {
    return
  }

  context.font = LABEL_FONT
  context.textBaseline = 'middle'
  context.lineJoin = 'round'
  context.lineWidth = 4
  context.strokeStyle = halo
  context.fillStyle = ink

  places.forEach((place) => {
    context.textAlign = place.align
    context.strokeText(place.name, place.x, place.y)
    context.fillText(place.name, place.x, place.y)
  })
}

const overlaps = (a, b) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2

const grown = (box, by) => ({ x1: box.x1 - by, y1: box.y1 - by, x2: box.x2 + by, y2: box.y2 + by })

// Whether the segment from `a` to `b` passes through `box` (Liang–Barsky clipping).
const crosses = (a, b, box) => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  let enter = 0
  let leave = 1

  return [[-dx, a.x - box.x1], [dx, box.x2 - a.x], [-dy, a.y - box.y1], [dy, box.y2 - a.y]].every(([p, q]) => {
    if (p === 0) {
      return q >= 0
    }

    const t = q / p

    if (p < 0) {
      enter = Math.max(enter, t)
    } else {
      leave = Math.min(leave, t)
    }

    return enter <= leave
  })
}

// Whether `box` reaches into the circle round `at` of `radius`.
const touches = (box, at, radius) => {
  const dx = at.x - Math.max(box.x1, Math.min(at.x, box.x2))
  const dy = at.y - Math.max(box.y1, Math.min(at.y, box.y2))

  return dx * dx + dy * dy < radius * radius
}

// Where each part's name goes: [{ name, x, y, align, box }], in map units. A name sits on the left or
// the right of one of the part's systems: level with it just outside its shape, or just above or
// below the system's ring, in the gap where no system's name is drawn. The place chosen covers the
// fewest markers, system names and other parts' names, then crosses the fewest links and shapes,
// then has the least close by. Larger parts choose first. `systems` are every system's id, `links`
// every link ({ source, target }) and `nameOf(id)` a system's name; `context` measures the text.
export const placeLabels = (context, parts, { systems, links, positionOf, sizeOf, nameOf }) => {
  const obstacles = []

  context.font = NAME_FONT
  systems.forEach((id) => {
    const at = positionOf(id)

    if (at) {
      const half = sizeOf(id) / 2
      const width = context.measureText(nameOf(id)).width + 4

      obstacles.push({ x1: at.x - half, y1: at.y - half, x2: at.x + half, y2: at.y + half })
      obstacles.push({ x1: at.x - width / 2, y1: at.y + half + NAME_DROP, x2: at.x + width / 2, y2: at.y + half + NAME_DROP + NAME_HEIGHT })
    }
  })

  const segments = links.map(({ source, target }) => [positionOf(source), positionOf(target)]).filter(([a, b]) => a && b)
  const rings = parts.flatMap((part) => part.ids.map((id) => ({ at: positionOf(id), radius: sizeOf(id) / 2 + ROOM + LINE })).filter((ring) => ring.at))
  const places = []
  const height = LABEL_SIZE * 1.2

  context.font = LABEL_FONT
  ;[...parts].filter((part) => part.owner.name).sort((a, b) => b.ids.length - a.ids.length).forEach((part) => {
    const name = part.owner.name
    const width = context.measureText(name).width
    const blockers = obstacles.concat(places.map((place) => place.box))
    let best = null

    part.ids.forEach((id) => {
      const at = positionOf(id)

      if (!at) {
        return
      }

      const reach = sizeOf(id) / 2 + ROOM + LINE
      // Level with the system, clear of its ring; or over or under the ring, clear of a link's band
      // running straight up or down from it.
      const beside = reach + LABEL_GAP
      const off = BAND + LABEL_GAP
      const rise = reach + LABEL_GAP / 2 + height / 2

      ;[[beside, 0, 0], [off, rise, 1], [off, -rise, 1]].forEach(([dx, dy, away]) => {
        const y = at.y + dy

        ;[
          { align: 'left', x: at.x + dx, box: { x1: at.x + dx, y1: y - height / 2, x2: at.x + dx + width, y2: y + height / 2 } },
          { align: 'right', x: at.x - dx, box: { x1: at.x - dx - width, y1: y - height / 2, x2: at.x - dx, y2: y + height / 2 } },
        ].forEach((candidate) => {
          const covered = blockers.filter((box) => overlaps(box, candidate.box)).length
          const crossed = segments.filter(([a, b]) => crosses(a, b, candidate.box)).length + rings.filter((ring) => touches(candidate.box, ring.at, ring.radius)).length
          const near = blockers.filter((box) => overlaps(box, grown(candidate.box, CROWD))).length
          // Compared in order: what it covers, what it crosses, what's near, level with its
          // system, higher up the map, then the right side.
          const cost = [covered, crossed, near, away, y, candidate.align === 'left' ? 0 : 1]
          const differs = best ? cost.findIndex((value, i) => value !== best.cost[i]) : 0

          if (!best || (differs > -1 && cost[differs] < best.cost[differs])) {
            best = { ...candidate, y, cost }
          }
        })
      })
    })

    if (best) {
      places.push({ name, x: best.x, y: best.y, align: best.align, box: best.box })
    }
  })

  return places
}

// The box the parts cover in map units, with the names `places` puts beside them, or null when
// there are none.
export const bordersBox = (parts, { positionOf, sizeOf }, places = []) => {
  let box = null

  const take = (x1, y1, x2, y2) => {
    box = box || { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }
    box.x1 = Math.min(box.x1, x1)
    box.y1 = Math.min(box.y1, y1)
    box.x2 = Math.max(box.x2, x2)
    box.y2 = Math.max(box.y2, y2)
  }

  parts.forEach((part) => part.ids.forEach((id) => {
    const at = positionOf(id)

    if (at) {
      const reach = sizeOf(id) / 2 + ROOM + LINE

      take(at.x - reach, at.y - reach, at.x + reach, at.y + reach)
    }
  }))
  places.forEach((place) => take(place.box.x1 - 4, place.box.y1 - 4, place.box.x2 + 4, place.box.y2 + 4))

  return box
}
