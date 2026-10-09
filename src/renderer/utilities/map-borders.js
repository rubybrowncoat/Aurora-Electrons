// Borders round the systems of a sector or an alien race on the Galaxy Map. Linked systems of one group
// share a shape that takes in the links between them; a system or cluster cut off from the rest of its
// group gets a shape of its own.

// Room round a system's marker inside its border, the half width of the band along a link, and the
// border's line, in map units. The band is narrower than the smallest system's room, so each link
// shows as a neck between its systems.
const ROOM = 26
const BAND = 34
const LINE = 3
const TINT = 0.14
// The group's name over each shape, in map units. Like the systems' names, it shows once it would
// be 9 pixels tall on screen.
const LABEL_SIZE = 16
const LABEL_MIN_PX = 9

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
// ones where they meet. `positionOf(id)` and `sizeOf(id)` give a system's place and marker size.
export const drawBorders = (context, parts, { positionOf, sizeOf, zoom, ink, halo, labels = true }) => {
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

  if (!labels || LABEL_SIZE * zoom < LABEL_MIN_PX) {
    return
  }

  context.font = `500 ${LABEL_SIZE}px Roboto, sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'bottom'
  context.lineJoin = 'round'
  context.lineWidth = 4
  context.strokeStyle = halo
  context.fillStyle = ink

  // Over the part's topmost system, clear of the line.
  parts.forEach((part) => {
    let top = null

    part.ids.forEach((id) => {
      const at = positionOf(id)

      if (at) {
        const y = at.y - sizeOf(id) / 2 - ROOM - line

        if (!top || y < top.y) {
          top = { x: at.x, y }
        }
      }
    })

    if (top) {
      context.strokeText(part.owner.name, top.x, top.y - 4)
      context.fillText(part.owner.name, top.x, top.y - 4)
    }
  })
}

// The box the parts cover in map units, their names included, or null when there are none.
export const bordersBox = (parts, { positionOf, sizeOf }) => {
  let box = null

  parts.forEach((part) => part.ids.forEach((id) => {
    const at = positionOf(id)

    if (at) {
      const reach = sizeOf(id) / 2 + ROOM + LINE

      box = box || { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }
      box.x1 = Math.min(box.x1, at.x - reach)
      box.x2 = Math.max(box.x2, at.x + reach)
      box.y1 = Math.min(box.y1, at.y - reach - LABEL_SIZE - 8)
      box.y2 = Math.max(box.y2, at.y + reach)
    }
  }))

  return box
}
