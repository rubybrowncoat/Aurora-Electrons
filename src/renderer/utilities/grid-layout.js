// Grid layout for the galactic map.
//
// Places each known system on a square grid the way players arrange their maps by hand (the
// maps on issue #60 and the saves measured for it): one system per cell, links along the
// horizontal, vertical and 45° lines, chains straight, dead ends beside their parent, and no
// link crossing another link or passing over a system. It is a multicriteria search on the
// grid (Stott, Rodgers et al. 2011, "Automatic Metro Map Layout Using Multicriteria
// Optimization"): every rule below is a cost, and a move is kept when it lowers the sum.
//
// A rebuild starts from a stress layout (straight-line distances that match the jumps
// between systems), turned to match the map the player has; a tidy-up starts from the map as
// it is and pays for every cell a system moves. Both then snap to the grid and improve it.
//
// `gridLayout` is a generator: it yields { phase, progress } often so the page can run it in
// slices between frames, and returns { positions, cost }.

export const GRID_LAYOUT_DEFAULTS = {
  mode: 'rebuild',
  diagonals: true,
  spacing: 140,
  aspect: 1.5,
  seed: 1,
}

const WEIGHTS = {
  crossing: 200,
  occlusion: 200,
  near: 10,
  length: 2,
  lengthSquared: 0.4,
  diagonal: 0.6,
  noDiagonal: 8,
  oblique: 5,
  angle: 3,
  bend: 0.8,
  gravity: 0.06,
  stability: 1.2,
  cohesion: 0.6,
  separation: 4,
  room: 2,
  guide: 1,
}

const NEIGHBOUR_CELLS = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]]

// The seven symmetries of the square other than doing nothing, as [xx, xy, yx, yy].
const SYMMETRIES = [[0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0], [-1, 0, 0, 1], [1, 0, 0, -1], [0, 1, 1, 0], [0, -1, -1, 0]]

const BUCKET = 4

const cellKey = (x, y) => (x + 32768) * 65536 + (y + 32768)
const bucketKey = (bx, by) => (bx + 8192) * 16384 + (by + 8192)

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// The grid the player's map already uses, in game units: the most common gap between linked
// systems along either axis (rounded to 10 so a hand-dragged map still counts). A map with no
// clear grid uses the median link instead, so a free layout still reads as about one cell a
// link.
function detectSpacing(positions, edges, fallback) {
  const counts = new Map()
  const lengths = []
  for (const [a, b] of edges) {
    const pa = positions[a]
    const pb = positions[b]
    if (!pa || !pb) {
      continue
    }

    const dx = Math.abs(pa.x - pb.x)
    const dy = Math.abs(pa.y - pb.y)
    lengths.push(Math.max(dx, dy))
    for (const delta of [dx, dy]) {
      const rounded = Math.round(delta / 10) * 10
      if (rounded >= 40 && rounded <= 400) {
        counts.set(rounded, (counts.get(rounded) || 0) + 1)
      }
    }
  }

  let best = fallback
  let bestCount = 0
  let total = 0
  for (const [delta, count] of counts) {
    total += count
    if (count > bestCount || (count === bestCount && delta > best)) {
      best = delta
      bestCount = count
    }
  }

  if (total && bestCount / total >= 0.25) {
    return best
  }

  if (!lengths.length) {
    return fallback
  }

  lengths.sort((p, q) => p - q)

  return Math.min(400, Math.max(40, Math.round(lengths[Math.floor(lengths.length / 2)] / 10) * 10))
}

function buildState({ nodes, edges, capitalId, options }) {
  const n = nodes.length
  const index = new Map(nodes.map((node, i) => [String(node.id), i]))

  const seen = new Set()
  const ea = []
  const eb = []
  for (const [source, target] of edges) {
    const a = index.get(String(source))
    const b = index.get(String(target))
    if (a === undefined || b === undefined || a === b) {
      continue
    }

    const key = a < b ? `${a}-${b}` : `${b}-${a}`
    if (!seen.has(key)) {
      seen.add(key)
      ea.push(a)
      eb.push(b)
    }
  }

  const m = ea.length
  const incident = Array.from({ length: n }, () => [])
  const neighbours = Array.from({ length: n }, () => [])
  for (let e = 0; e < m; e += 1) {
    incident[ea[e]].push(e)
    incident[eb[e]].push(e)
    neighbours[ea[e]].push(eb[e])
    neighbours[eb[e]].push(ea[e])
  }

  const groupKeys = new Map()
  const group = new Int32Array(n).fill(-1)
  nodes.forEach((node, i) => {
    if (node.group === null || node.group === undefined || node.group === '') {
      return
    }

    if (!groupKeys.has(node.group)) {
      groupKeys.set(node.group, groupKeys.size)
    }

    group[i] = groupKeys.get(node.group)
  })

  const capital = index.has(String(capitalId)) ? index.get(String(capitalId)) : 0

  return {
    n,
    m,
    ids: nodes.map((node) => String(node.id)),
    ea: Int32Array.from(ea),
    eb: Int32Array.from(eb),
    incident,
    neighbours,
    capital,
    pinned: Uint8Array.from(nodes, (node) => (node.pinned ? 1 : 0)),

    group,
    groupX: new Float64Array(groupKeys.size),
    groupY: new Float64Array(groupKeys.size),
    groupCount: new Int32Array(groupKeys.size),

    x: new Int32Array(n),
    y: new Int32Array(n),
    placed: new Uint8Array(n),
    occupied: new Map(),

    // Where the search would like each system: its cell in a tidy-up (paid per cell moved),
    // or its snapped stress position while a rebuild first puts systems down.
    homeX: new Int32Array(n),
    homeY: new Int32Array(n),
    hasHome: new Uint8Array(n),
    guideX: new Float64Array(n),
    guideY: new Float64Array(n),
    guided: false,
    stable: options.mode === 'tidy',
    room: false,

    // Links by the 4×4 block of cells their bounding box touches, to find nearby links fast.
    buckets: new Map(),
    edgeBuckets: Array.from({ length: m }, () => []),
    edgeSeen: new Int32Array(m),
    edgeStamp: 0,

    weights: {
      ...WEIGHTS,
      diagonal: options.diagonals ? WEIGHTS.diagonal : WEIGHTS.noDiagonal,
    },
    aspect: options.aspect,

    mark: new Uint8Array(n),
    edgeMark: new Uint8Array(m),
    angleMark: new Uint8Array(n),
  }
}

function registerEdge(state, e) {
  const { x, y, ea, eb, buckets } = state
  const a = ea[e]
  const b = eb[e]
  const keys = state.edgeBuckets[e]
  const fromX = Math.floor(Math.min(x[a], x[b]) / BUCKET)
  const toX = Math.floor(Math.max(x[a], x[b]) / BUCKET)
  const fromY = Math.floor(Math.min(y[a], y[b]) / BUCKET)
  const toY = Math.floor(Math.max(y[a], y[b]) / BUCKET)
  for (let bx = fromX; bx <= toX; bx += 1) {
    for (let by = fromY; by <= toY; by += 1) {
      const key = bucketKey(bx, by)
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = new Set()
        buckets.set(key, bucket)
      }

      bucket.add(e)
      keys.push(key)
    }
  }
}

function unregisterEdge(state, e) {
  const keys = state.edgeBuckets[e]
  for (const key of keys) {
    state.buckets.get(key).delete(e)
  }

  keys.length = 0
}

function place(state, v, x, y) {
  state.x[v] = x
  state.y[v] = y
  state.placed[v] = 1
  state.occupied.set(cellKey(x, y), v)

  for (const e of state.incident[v]) {
    if (state.placed[state.ea[e] === v ? state.eb[e] : state.ea[e]]) {
      registerEdge(state, e)
    }
  }

  const g = state.group[v]
  if (g >= 0) {
    state.groupX[g] += x
    state.groupY[g] += y
    state.groupCount[g] += 1
  }
}

function unplace(state, v) {
  for (const e of state.incident[v]) {
    if (state.placed[state.ea[e] === v ? state.eb[e] : state.ea[e]]) {
      unregisterEdge(state, e)
    }
  }

  state.occupied.delete(cellKey(state.x[v], state.y[v]))
  state.placed[v] = 0

  const g = state.group[v]
  if (g >= 0) {
    state.groupX[g] -= state.x[v]
    state.groupY[g] -= state.y[v]
    state.groupCount[g] -= 1
  }
}

function clearCells(state) {
  for (let v = 0; v < state.n; v += 1) {
    if (state.placed[v]) {
      unplace(state, v)
    }
  }
}

// Long links cost more the longer they get; links off the eight directions cost extra.
function edgeCost(state, e) {
  const { x, y, ea, eb, weights } = state
  const dx = Math.abs(x[ea[e]] - x[eb[e]])
  const dy = Math.abs(y[ea[e]] - y[eb[e]])
  const extra = Math.max(dx, dy) - 1

  let cost = weights.length * extra + weights.lengthSquared * extra * extra
  if (dx !== 0 && dy !== 0) {
    cost += dx === dy ? weights.diagonal : weights.oblique
  }

  return cost
}

const orientation = (ax, ay, bx, by, cx, cy) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax))

const within = (a, b, c) => (a <= b ? a <= c && c <= b : b <= c && c <= a)

// Two links that cross or run over each other; links that share a system never count.
function edgesCross(state, e, f) {
  const { x, y, ea, eb } = state
  const a = ea[e]
  const b = eb[e]
  const c = ea[f]
  const d = eb[f]
  if (a === c || a === d || b === c || b === d) {
    return false
  }

  const ax = x[a]
  const ay = y[a]
  const bx = x[b]
  const by = y[b]
  const cx = x[c]
  const cy = y[c]
  const dx = x[d]
  const dy = y[d]
  if (Math.max(ax, bx) < Math.min(cx, dx) || Math.max(cx, dx) < Math.min(ax, bx) || Math.max(ay, by) < Math.min(cy, dy) || Math.max(cy, dy) < Math.min(ay, by)) {
    return false
  }

  const o1 = orientation(ax, ay, bx, by, cx, cy)
  const o2 = orientation(ax, ay, bx, by, dx, dy)
  const o3 = orientation(cx, cy, dx, dy, ax, ay)
  const o4 = orientation(cx, cy, dx, dy, bx, by)
  if (o1 * o2 < 0 && o3 * o4 < 0) {
    return true
  }

  return (o1 === 0 && within(ax, bx, cx) && within(ay, by, cy)) || (o2 === 0 && within(ax, bx, dx) && within(ay, by, dy)) || (o3 === 0 && within(cx, dx, ax) && within(cy, dy, ay)) || (o4 === 0 && within(cx, dx, bx) && within(cy, dy, by))
}

// A link running over a system it doesn't join, or close enough to touch its marker.
function occlusionCost(state, e, w) {
  const { x, y, ea, eb, weights } = state
  const a = ea[e]
  const b = eb[e]
  if (w === a || w === b) {
    return 0
  }

  const ax = x[a]
  const ay = y[a]
  const bx = x[b]
  const by = y[b]
  const wx = x[w]
  const wy = y[w]
  if (wx < Math.min(ax, bx) || wx > Math.max(ax, bx) || wy < Math.min(ay, by) || wy > Math.max(ay, by)) {
    return 0
  }

  const dx = bx - ax
  const dy = by - ay
  const cross = dx * (wy - ay) - dy * (wx - ax)
  if (cross === 0) {
    return weights.occlusion
  }

  const lengthSquared = dx * dx + dy * dy
  const projection = dx * (wx - ax) + dy * (wy - ay)
  if (projection <= 0 || projection >= lengthSquared) {
    return 0
  }

  // Within a quarter cell the line runs over the marker; within about half it grazes it.
  const distanceSquared = (cross * cross) / lengthSquared

  return distanceSquared < 0.0625 ? weights.occlusion : distanceSquared < 0.2 ? weights.near : 0
}

// The gaps between a system's links: up to four links want 90° apart, more share the
// circle. A system with two links also pays for every 45° its line turns.
function angleCost(state, v) {
  const { x, y, ea, eb, incident, placed, weights } = state
  const angles = []
  for (const e of incident[v]) {
    const other = ea[e] === v ? eb[e] : ea[e]
    if (placed[other]) {
      angles.push((Math.atan2(y[other] - y[v], x[other] - x[v]) * 180) / Math.PI)
    }
  }

  if (angles.length < 2) {
    return 0
  }

  angles.sort((p, q) => p - q)

  const wanted = angles.length <= 4 ? 90 : Math.max(45, 360 / angles.length)
  let cost = 0
  for (let i = 0; i < angles.length; i += 1) {
    const gap = i + 1 < angles.length ? angles[i + 1] - angles[i] : angles[0] + 360 - angles[i]
    if (gap < wanted - 0.5) {
      cost += (wanted - gap) / 45
    }
  }

  cost *= weights.angle

  if (angles.length === 2 && incident[v].length === 2) {
    const turn = Math.abs(angles[1] - angles[0])
    cost += (weights.bend * (180 - Math.min(turn, 360 - turn))) / 45
  }

  return cost
}

// Costs of where a system sits: away from the capital (or from its cell in a tidy-up, or
// from its stress position while snapping), away from its group, or boxed in with links
// still to place.
function nodeCost(state, v) {
  const { x, y, group, weights } = state
  let cost = 0

  if (state.stable && state.hasHome[v]) {
    cost += weights.stability * Math.max(Math.abs(x[v] - state.homeX[v]), Math.abs(y[v] - state.homeY[v]))
  } else {
    const gx = (x[v] - x[state.capital]) / state.aspect
    const gy = y[v] - y[state.capital]
    cost += weights.gravity * Math.sqrt(gx * gx + gy * gy)
  }

  if (state.guided) {
    cost += weights.guide * Math.sqrt((x[v] - state.guideX[v]) ** 2 + (y[v] - state.guideY[v]) ** 2)
  }

  const g = group[v]
  if (g >= 0 && state.groupCount[g] > 1) {
    const cx = state.groupX[g] / state.groupCount[g]
    const cy = state.groupY[g] / state.groupCount[g]
    cost += weights.cohesion * Math.sqrt((x[v] - cx) ** 2 + (y[v] - cy) ** 2)
  }

  if (state.room) {
    let waiting = 0
    for (const w of state.neighbours[v]) {
      if (!state.placed[w]) {
        waiting += 1
      }
    }

    if (waiting) {
      let free = 0
      for (const [dx, dy] of NEIGHBOUR_CELLS) {
        if (!state.occupied.has(cellKey(x[v] + dx, y[v] + dy))) {
          free += 1
        }
      }

      cost += weights.room * Math.max(0, waiting + 1 - free)
    }
  }

  return cost
}

// Systems side by side that aren't in the same group, where at least one is in a group, so
// a group keeps outsiders out as well as other groups; each pair counted once.
function separationCost(state, v) {
  if (!state.groupCount.length) {
    return 0
  }

  const g = state.group[v]
  let cost = 0
  for (const [dx, dy] of NEIGHBOUR_CELLS) {
    const w = state.occupied.get(cellKey(state.x[v] + dx, state.y[v] + dy))
    if (w !== undefined && state.group[w] !== g && (g >= 0 || state.group[w] >= 0) && (!state.mark[w] || w > v)) {
      cost += state.weights.separation
    }
  }

  return cost
}

// Every cost that involves a system in `set`, each counted once.
function localCost(state, set) {
  const { n, ea, eb, incident, placed, neighbours, mark, edgeMark, angleMark, buckets, edgeSeen, weights } = state
  for (const v of set) {
    mark[v] = 1
  }

  const local = []
  for (const v of set) {
    for (const e of incident[v]) {
      if (!edgeMark[e] && placed[ea[e]] && placed[eb[e]]) {
        edgeMark[e] = 1
        local.push(e)
      }
    }
  }

  let cost = 0
  for (const e of local) {
    cost += edgeCost(state, e)

    state.edgeStamp += 1
    const stamp = state.edgeStamp
    edgeSeen[e] = stamp
    for (const key of state.edgeBuckets[e]) {
      for (const f of buckets.get(key)) {
        if (edgeSeen[f] === stamp) {
          continue
        }

        edgeSeen[f] = stamp
        if ((!edgeMark[f] || f > e) && edgesCross(state, e, f)) {
          cost += weights.crossing
        }
      }
    }

    // Systems inside the link's bounding box.
    const a = ea[e]
    const b = eb[e]
    const fromX = Math.min(state.x[a], state.x[b])
    const toX = Math.max(state.x[a], state.x[b])
    const fromY = Math.min(state.y[a], state.y[b])
    const toY = Math.max(state.y[a], state.y[b])
    if ((toX - fromX + 1) * (toY - fromY + 1) <= n) {
      for (let cx = fromX; cx <= toX; cx += 1) {
        for (let cy = fromY; cy <= toY; cy += 1) {
          const w = state.occupied.get(cellKey(cx, cy))
          if (w !== undefined) {
            cost += occlusionCost(state, e, w)
          }
        }
      }
    } else {
      for (let w = 0; w < n; w += 1) {
        if (placed[w]) {
          cost += occlusionCost(state, e, w)
        }
      }
    }
  }

  for (const v of set) {
    const bucket = buckets.get(bucketKey(Math.floor(state.x[v] / BUCKET), Math.floor(state.y[v] / BUCKET)))
    if (bucket) {
      for (const f of bucket) {
        if (!edgeMark[f]) {
          cost += occlusionCost(state, f, v)
        }
      }
    }
  }

  const angled = []
  for (const v of set) {
    if (!angleMark[v]) {
      angleMark[v] = 1
      angled.push(v)
    }

    for (const w of neighbours[v]) {
      if (placed[w] && !angleMark[w]) {
        angleMark[w] = 1
        angled.push(w)
      }
    }
  }

  for (const v of angled) {
    cost += angleCost(state, v)
    angleMark[v] = 0
  }

  for (const v of set) {
    cost += nodeCost(state, v) + separationCost(state, v)
  }

  for (const e of local) {
    edgeMark[e] = 0
  }

  for (const v of set) {
    mark[v] = 0
  }

  return cost
}

function totalCost(state) {
  const placed = []
  for (let v = 0; v < state.n; v += 1) {
    if (state.placed[v]) {
      placed.push(v)
    }
  }

  return localCost(state, placed)
}

function snapshot(state, set) {
  const cells = new Int32Array(set.length * 2)
  set.forEach((v, i) => {
    cells[i * 2] = state.x[v]
    cells[i * 2 + 1] = state.y[v]
  })

  return cells
}

// Moves `set` to the cells in `targets` ([x0, y0, x1, y1, …]) if no other system holds them.
function moveSet(state, set, targets) {
  for (const v of set) {
    state.mark[v] = 1
  }

  let free = true
  for (let i = 0; i < set.length && free; i += 1) {
    const holder = state.occupied.get(cellKey(targets[i * 2], targets[i * 2 + 1]))
    if (holder !== undefined && !state.mark[holder]) {
      free = false
    }
  }

  for (const v of set) {
    state.mark[v] = 0
  }

  if (!free) {
    return false
  }

  for (const v of set) {
    unplace(state, v)
  }

  set.forEach((v, i) => place(state, v, targets[i * 2], targets[i * 2 + 1]))

  return true
}

// Tries each candidate layout of `set` and keeps the cheapest if it beats the current one.
// While the search is warm a worse layout can win too, with a chance that shrinks with how
// much worse it is, so the search can climb out of a dead end (simulated annealing).
function tryCandidates(state, set, candidates, rng, temperature = 0) {
  const before = localCost(state, set)
  const original = snapshot(state, set)

  let best = null
  let bestCost = Infinity
  for (const targets of candidates) {
    if (!moveSet(state, set, targets)) {
      continue
    }

    const cost = localCost(state, set)
    if (cost < bestCost) {
      bestCost = cost
      best = targets
    }

    moveSet(state, set, original)
  }

  if (!best) {
    return 0
  }

  const change = bestCost - before
  if (change < -1e-6 || (temperature > 0 && change > 1e-6 && rng() < Math.exp(-change / temperature))) {
    moveSet(state, set, best)
    return Math.max(0, -change)
  }

  return 0
}

// Moves `set` so its first system lands on each cell, keeping the rest in formation.
function translations(state, set, cells) {
  const v = set[0]
  return cells.map(([x, y]) => {
    const dx = x - state.x[v]
    const dy = y - state.y[v]
    const targets = new Int32Array(set.length * 2)
    set.forEach((w, i) => {
      targets[i * 2] = state.x[w] + dx
      targets[i * 2 + 1] = state.y[w] + dy
    })

    return targets
  })
}

// Hops between every pair of systems. Pairs in different pieces of the map get one more than
// the longest path; systems of one group sit a little closer and of two groups a little
// further, so groups start out together.
function hopDistances(state) {
  const { n, neighbours, group } = state
  const distances = new Float64Array(n * n).fill(-1)
  const queue = new Int32Array(n)
  let longest = 1
  for (let source = 0; source < n; source += 1) {
    const row = source * n
    distances[row + source] = 0
    let head = 0
    let tail = 0
    queue[tail++] = source
    while (head < tail) {
      const v = queue[head++]
      for (const w of neighbours[v]) {
        if (distances[row + w] < 0) {
          distances[row + w] = distances[row + v] + 1
          longest = Math.max(longest, distances[row + w])
          queue[tail++] = w
        }
      }
    }
  }

  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const k = i * n + j
      if (distances[k] < 0) {
        distances[k] = longest + 1
      }

      if (i !== j && group[i] >= 0 && group[j] >= 0) {
        distances[k] *= group[i] === group[j] ? 0.8 : 1.25
      }
    }
  }

  return distances
}

// A stress layout (Gansner, Koren and North 2004), started from the two leading axes of the
// distances (classical scaling by power iteration) so it doesn't depend on a random start.
function* stressCoordinates(state, rng) {
  const { n } = state
  const distances = hopDistances(state)

  const centred = new Float64Array(n * n)
  const rowMean = new Float64Array(n)
  let mean = 0
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const squared = distances[i * n + j] ** 2
      centred[i * n + j] = squared
      rowMean[i] += squared / n
    }

    mean += rowMean[i] / n
  }

  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      centred[i * n + j] = -0.5 * (centred[i * n + j] - rowMean[i] - rowMean[j] + mean)
    }
  }

  const axes = []
  for (let axis = 0; axis < 2; axis += 1) {
    let vector = Float64Array.from({ length: n }, () => rng() - 0.5)
    let value = 0
    for (let iteration = 0; iteration < 60; iteration += 1) {
      const next = new Float64Array(n)
      for (let i = 0; i < n; i += 1) {
        let sum = 0
        for (let j = 0; j < n; j += 1) {
          sum += centred[i * n + j] * vector[j]
        }

        next[i] = sum
      }

      for (const previous of axes) {
        let dot = 0
        for (let i = 0; i < n; i += 1) {
          dot += next[i] * previous.vector[i]
        }

        for (let i = 0; i < n; i += 1) {
          next[i] -= dot * previous.vector[i]
        }
      }

      let norm = 0
      for (let i = 0; i < n; i += 1) {
        norm += next[i] * next[i]
      }

      norm = Math.sqrt(norm) || 1
      value = norm
      vector = next.map((component) => component / norm)
    }

    axes.push({ vector, value })
    yield { phase: 'stress', progress: 0.1 * (axis + 1) }
  }

  const sx = Float64Array.from(axes[0].vector, (component) => component * Math.sqrt(axes[0].value) + (rng() - 0.5) * 1e-3)
  const sy = Float64Array.from(axes[1].vector, (component) => component * Math.sqrt(axes[1].value) + (rng() - 0.5) * 1e-3)

  // Stress majorization one system at a time, with weights 1 / d².
  const iterations = 300
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let moved = 0
    for (let i = 0; i < n; i += 1) {
      let nx = 0
      let ny = 0
      let weights = 0
      for (let j = 0; j < n; j += 1) {
        if (i === j) {
          continue
        }

        const d = distances[i * n + j]
        const w = 1 / (d * d)
        const dx = sx[i] - sx[j]
        const dy = sy[i] - sy[j]
        const length = Math.sqrt(dx * dx + dy * dy) || 1e-9
        nx += w * (sx[j] + (d * dx) / length)
        ny += w * (sy[j] + (d * dy) / length)
        weights += w
      }

      nx /= weights
      ny /= weights
      moved = Math.max(moved, Math.abs(nx - sx[i]) + Math.abs(ny - sy[i]))
      sx[i] = nx
      sy[i] = ny
    }

    if (iteration % 10 === 0) {
      yield { phase: 'stress', progress: 0.2 + (0.8 * iteration) / iterations }
    }

    if (moved < 1e-4) {
      break
    }
  }

  return { sx, sy }
}

// Turns (and if need be mirrors) the stress layout about the capital to sit as close as it
// can to the map the player has, so a rebuild keeps the map's orientation.
function alignToCurrent(state, sx, sy, current) {
  const { n, capital } = state
  const ox = sx[capital]
  const oy = sy[capital]
  const home = current[capital] || { x: 0, y: 0 }

  let best = { cos: 1, sin: 0, mirror: 1, fit: -Infinity }
  for (const mirror of [1, -1]) {
    let a = 0
    let b = 0
    for (let v = 0; v < n; v += 1) {
      if (!current[v]) {
        continue
      }

      const x = sx[v] - ox
      const y = mirror * (sy[v] - oy)
      const tx = current[v].x - home.x
      const ty = current[v].y - home.y
      a += x * tx + y * ty
      b += x * ty - y * tx
    }

    const fit = Math.sqrt(a * a + b * b)
    if (fit > best.fit) {
      best = { cos: fit ? a / fit : 1, sin: fit ? b / fit : 0, mirror, fit }
    }
  }

  for (let v = 0; v < n; v += 1) {
    const x = sx[v] - ox
    const y = best.mirror * (sy[v] - oy)
    sx[v] = x * best.cos - y * best.sin
    sy[v] = x * best.sin + y * best.cos
  }
}

// Puts systems down one at a time, outward from the capital, each on the cheapest free cell
// near where `targetX`/`targetY` (in cells) would have it. Pinned systems go first, on their
// own cells.
function* placeNear(state, targetX, targetY, rng) {
  const { n, neighbours, capital } = state
  state.guided = true
  state.room = true
  state.guideX.set(targetX)
  state.guideY.set(targetY)

  for (let v = 0; v < n; v += 1) {
    if (state.pinned[v] && state.hasHome[v] && !state.occupied.has(cellKey(state.homeX[v], state.homeY[v]))) {
      place(state, v, state.homeX[v], state.homeY[v])
    }
  }

  // Breadth first from the capital, then from each loose piece's best connected system.
  const order = []
  const queued = new Uint8Array(n)
  const starts = [capital, ...[...Array(n).keys()].sort((p, q) => neighbours[q].length - neighbours[p].length)]
  for (const start of starts) {
    if (queued[start]) {
      continue
    }

    queued[start] = 1
    order.push(start)
    for (let i = order.length - 1; i < order.length; i += 1) {
      const children = neighbours[order[i]].filter((w) => !queued[w]).sort((p, q) => neighbours[q].length - neighbours[p].length)
      for (const w of children) {
        queued[w] = 1
        order.push(w)
      }
    }
  }

  let done = 0
  for (const v of order) {
    done += 1
    if (state.placed[v]) {
      continue
    }

    const cx = Math.round(targetX[v])
    const cy = Math.round(targetY[v])
    let bestCost = Infinity
    let bestX = cx
    let bestY = cy
    for (let radius = 0; radius <= 2 || bestCost === Infinity; radius += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dy = -radius; dy <= radius; dy += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius || state.occupied.has(cellKey(cx + dx, cy + dy))) {
            continue
          }

          place(state, v, cx + dx, cy + dy)
          const cost = localCost(state, [v]) + rng() * 1e-6
          unplace(state, v)
          if (cost < bestCost) {
            bestCost = cost
            bestX = cx + dx
            bestY = cy + dy
          }
        }
      }
    }

    place(state, v, bestX, bestY)
    if (done % 8 === 0) {
      yield { phase: 'place', progress: done / n }
    }
  }

  state.guided = false
  state.room = false
}

// The pieces that hang off the map by a single system: take that system away and they come
// loose from the capital. Each can turn about the system it hangs from, or shift, as a whole.
// A piece with no link to the capital's piece hangs from nothing (anchor -1).
function pendantPieces(state) {
  const { n, neighbours, capital } = state
  const pieces = []
  const label = new Int32Array(n)
  let stamp = 1

  const collect = (start, blocked) => {
    const members = [start]
    label[start] = stamp
    for (let i = 0; i < members.length; i += 1) {
      for (const w of neighbours[members[i]]) {
        if (w !== blocked && label[w] !== stamp) {
          label[w] = stamp
          members.push(w)
        }
      }
    }

    return members
  }

  const grouped = new Uint8Array(n)
  for (const v of collect(capital, -1)) {
    grouped[v] = 1
  }

  for (let v = 0; v < n; v += 1) {
    if (grouped[v]) {
      continue
    }

    stamp += 1
    const members = collect(v, -1)
    for (const w of members) {
      grouped[w] = 1
    }

    if (!members.some((w) => state.pinned[w])) {
      pieces.push({ anchor: -1, members })
    }
  }

  for (let anchor = 0; anchor < n; anchor += 1) {
    if (neighbours[anchor].length < 2) {
      continue
    }

    const first = stamp + 1
    for (const start of neighbours[anchor]) {
      if (label[start] >= first) {
        continue
      }

      stamp += 1
      const members = collect(start, anchor)
      if (label[capital] !== stamp && members.length > 1 && members.length <= n / 2 && !members.some((w) => state.pinned[w])) {
        pieces.push({ anchor, members })
      }
    }
  }

  return pieces.sort((p, q) => p.members.length - q.members.length)
}

// Runs of systems with two links each inside the map's loops (its 2-core), with whatever
// hangs off them: shifting one stretches or shrinks a loop without bending its corners.
function loopRuns(state, pieces) {
  const { n, neighbours } = state
  const degree = Int32Array.from(neighbours, (list) => list.length)
  const removed = new Uint8Array(n)
  const queue = []
  for (let v = 0; v < n; v += 1) {
    if (degree[v] <= 1) {
      queue.push(v)
    }
  }

  while (queue.length) {
    const v = queue.pop()
    if (removed[v]) {
      continue
    }

    removed[v] = 1
    for (const w of neighbours[v]) {
      degree[w] -= 1
      if (!removed[w] && degree[w] === 1) {
        queue.push(w)
      }
    }
  }

  const hanging = Array.from({ length: n }, () => [])
  for (const { anchor, members } of pieces) {
    if (anchor >= 0 && !removed[anchor] && members.every((w) => removed[w])) {
      hanging[anchor].push(...members)
    }
  }

  const runs = []
  const seen = new Uint8Array(n)
  for (let v = 0; v < n; v += 1) {
    if (removed[v] || degree[v] !== 2 || seen[v]) {
      continue
    }

    const run = [v]
    seen[v] = 1
    for (const side of neighbours[v].filter((w) => !removed[w])) {
      let previous = v
      let current = side
      while (current !== undefined && !removed[current] && degree[current] === 2 && !seen[current]) {
        seen[current] = 1
        if (side === neighbours[v].find((w) => !removed[w])) {
          run.unshift(current)
        } else {
          run.push(current)
        }

        const next = neighbours[current].find((w) => !removed[w] && w !== previous)
        previous = current
        current = next
      }
    }

    const members = [...run, ...run.flatMap((w) => hanging[w])]
    if (members.length > 1 && members.length <= n / 2 && !members.some((w) => state.pinned[w])) {
      runs.push(members)
    }
  }

  return runs
}

function shuffled(n, rng) {
  const order = [...Array(n).keys()]
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const swap = order[i]
    order[i] = order[j]
    order[j] = swap
  }

  return order
}

function* improve(state, rng, { heated, settle, warmth }) {
  const { n, neighbours } = state
  const pieces = pendantPieces(state)
  const runs = loopRuns(state, pieces)

  // What a system drags along when it moves: the pieces that hang from it.
  const carried = Array.from({ length: n }, () => [])
  for (const { anchor, members } of pieces) {
    if (anchor >= 0) {
      carried[anchor].push(...members)
    }
  }

  const carryLimit = Math.max(24, n / 8)
  const rounds = heated + settle
  const all = [...Array(n).keys()]
  let best = { cost: totalCost(state), cells: snapshot(state, all) }

  for (let round = 0; round < rounds; round += 1) {
    const temperature = round < heated ? warmth * (1 - round / heated) : 0
    const radius = round < rounds / 4 ? 3 : round < rounds / 2 ? 2 : 1
    let gain = 0

    const order = shuffled(n, rng)
    for (let k = 0; k < n; k += 1) {
      const v = order[k]
      if (state.pinned[v]) {
        continue
      }

      const cells = []
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dy = -radius; dy <= radius; dy += 1) {
          if (dx || dy) {
            cells.push([state.x[v] + dx, state.y[v] + dy])
          }
        }
      }

      // Beside each system it links to, wherever that is.
      for (const w of neighbours[v]) {
        for (const [dx, dy] of NEIGHBOUR_CELLS) {
          cells.push([state.x[w] + dx, state.y[w] + dy])
        }
      }

      gain += tryCandidates(state, [v], translations(state, [v], cells), rng, temperature)

      if (carried[v].length && carried[v].length < carryLimit) {
        const set = [v, ...carried[v]]
        gain += tryCandidates(state, set, translations(state, set, cells), rng, temperature)
      }

      // Trade places with a system that sits where this one would rather be.
      const traded = new Set()
      for (const [x, y] of cells) {
        const w = state.occupied.get(cellKey(x, y))
        if (w !== undefined && w !== v && !state.pinned[w] && !traded.has(w)) {
          traded.add(w)
          gain += tryCandidates(state, [v, w], [Int32Array.of(state.x[w], state.y[w], state.x[v], state.y[v])], rng, temperature)
        }
      }

      if (k % 4 === 0) {
        yield { phase: 'improve', progress: (round + (0.8 * k) / n) / rounds }
      }
    }

    for (let p = 0; p < pieces.length; p += 1) {
      const { anchor, members } = pieces[p]
      const pivot = anchor >= 0 ? anchor : members[0]
      const ax = state.x[pivot]
      const ay = state.y[pivot]
      const candidates = translations(state, members, NEIGHBOUR_CELLS.map(([dx, dy]) => [state.x[members[0]] + dx, state.y[members[0]] + dy]))

      // Turned or mirrored about the system it hangs from.
      for (const [xx, xy, yx, yy] of SYMMETRIES) {
        const targets = new Int32Array(members.length * 2)
        members.forEach((v, i) => {
          const rx = state.x[v] - ax
          const ry = state.y[v] - ay
          targets[i * 2] = ax + xx * rx + xy * ry
          targets[i * 2 + 1] = ay + yx * rx + yy * ry
        })

        candidates.push(targets)
      }

      gain += tryCandidates(state, members, candidates, rng, temperature)

      if (p % 4 === 0) {
        yield { phase: 'improve', progress: (round + 0.8 + (0.1 * p) / pieces.length) / rounds }
      }
    }

    for (const members of runs) {
      const cells = []
      for (const [dx, dy] of NEIGHBOUR_CELLS) {
        cells.push([state.x[members[0]] + dx, state.y[members[0]] + dy], [state.x[members[0]] + dx * 2, state.y[members[0]] + dy * 2])
      }

      gain += tryCandidates(state, members, translations(state, members, cells), rng, temperature)
    }

    const cost = totalCost(state)
    if (cost < best.cost - 1e-6) {
      best = { cost, cells: snapshot(state, all) }
    }

    yield { phase: 'improve', progress: (round + 1) / rounds }

    if (round >= heated && gain < 1e-6) {
      break
    }
  }

  if (totalCost(state) > best.cost + 1e-6) {
    moveSet(state, all, best.cells)
  }
}

// Lays out `nodes` ({ id, group, pinned }) joined by `edges` ([idA, idB]) on a grid.
// `positions` ({ id: { x, y } }, game units) is the map as it is: a tidy-up starts from it, a
// rebuild keeps its orientation, and pinned systems keep their place. The capital keeps its
// position and the rest is laid out around it, `options.spacing` game units apart.
export function* gridLayout({ nodes, edges, capitalId = null, positions = {}, options = {} }) {
  const settings = { ...GRID_LAYOUT_DEFAULTS, ...options }
  const state = buildState({ nodes, edges, capitalId, options: settings })
  const rng = mulberry32(settings.seed)

  if (!state.n) {
    return { positions: {}, cost: 0 }
  }

  const capitalPosition = positions[state.ids[state.capital]] || { x: 0, y: 0 }
  const origin = {
    x: Math.round(capitalPosition.x / 20) * 20,
    y: Math.round(capitalPosition.y / 20) * 20,
  }

  // Where each system sits now, in cells of the spacing the player's map already uses.
  const sourceSpacing = detectSpacing(positions, edges, settings.spacing)
  const current = state.ids.map((id) => {
    const position = positions[id]
    return position ? { x: (position.x - origin.x) / sourceSpacing, y: (position.y - origin.y) / sourceSpacing } : null
  })

  // Pinned systems stay where they are, on the cell of the new grid they fall in.
  for (let v = 0; v < state.n; v += 1) {
    const position = positions[state.ids[v]]
    if (state.pinned[v] && position) {
      state.homeX[v] = Math.round((position.x - origin.x) / settings.spacing)
      state.homeY[v] = Math.round((position.y - origin.y) / settings.spacing)
      state.hasHome[v] = 1
    }
  }

  if (settings.mode === 'tidy') {
    // Systems the game hasn't placed yet sit at their capital's cell; the search moves them.
    const targetX = Float64Array.from(current, (cell) => cell?.x ?? 0)
    const targetY = Float64Array.from(current, (cell) => cell?.y ?? 0)
    yield * placeNear(state, targetX, targetY, rng)
    for (let v = 0; v < state.n; v += 1) {
      state.homeX[v] = Math.round(targetX[v])
      state.homeY[v] = Math.round(targetY[v])
      state.hasHome[v] = 1
    }
  } else {
    const { sx, sy } = yield * stressCoordinates(state, rng)
    alignToCurrent(state, sx, sy, current)

    // The scale that snaps best: tight enough for short links, loose enough to keep apart.
    let bestScale = 1
    let bestCost = Infinity
    for (const scale of [1, 1.2, 1.4]) {
      clearCells(state)
      yield * placeNear(state, sx.map((x) => x * scale), sy.map((y) => y * scale), rng)
      const cost = totalCost(state)
      if (cost < bestCost) {
        bestCost = cost
        bestScale = scale
      }
    }

    if (bestScale !== 1.4) {
      clearCells(state)
      yield * placeNear(state, sx.map((x) => x * bestScale), sy.map((y) => y * bestScale), rng)
    }
  }

  // A tidy-up runs cooler: warming it much would wander off the player's arrangement.
  yield * improve(state, rng, settings.mode === 'tidy' ? { heated: 6, settle: 12, warmth: 2 } : { heated: 10, settle: 12, warmth: 4 })

  // Keep the capital where it is unless something is pinned to the old grid.
  let shiftX = 0
  let shiftY = 0
  if (!state.pinned.some(Boolean)) {
    shiftX = state.x[state.capital]
    shiftY = state.y[state.capital]
  }

  const result = {}
  for (let v = 0; v < state.n; v += 1) {
    const original = positions[state.ids[v]]
    result[state.ids[v]] = state.pinned[v] && original
      ? { x: original.x, y: original.y }
      : { x: origin.x + (state.x[v] - shiftX) * settings.spacing, y: origin.y + (state.y[v] - shiftY) * settings.spacing }
  }

  return { positions: result, cost: totalCost(state) }
}

// Runs the layout to the end in one go.
export function runGridLayout(input) {
  const iterator = gridLayout(input)
  for (;;) {
    const step = iterator.next()
    if (step.done) {
      return step.value
    }
  }
}

// How tidy a map is, in game units: links that cross, links that pass over a system's marker
// (`markerRadius`, 25 on the game's map), and links that run straight, at 45° or otherwise.
export function layoutQuality({ edges, positions, markerRadius = 25 }) {
  const segments = edges.map(([a, b]) => [String(a), String(b), positions[a], positions[b]]).filter(([, , pa, pb]) => pa && pb)
  const ids = Object.keys(positions)

  let crossings = 0
  for (let i = 0; i < segments.length; i += 1) {
    const [a, b, pa, pb] = segments[i]
    for (let j = i + 1; j < segments.length; j += 1) {
      const [c, d, pc, pd] = segments[j]
      if (a === c || a === d || b === c || b === d) {
        continue
      }

      const o1 = orientation(pa.x, pa.y, pb.x, pb.y, pc.x, pc.y)
      const o2 = orientation(pa.x, pa.y, pb.x, pb.y, pd.x, pd.y)
      const o3 = orientation(pc.x, pc.y, pd.x, pd.y, pa.x, pa.y)
      const o4 = orientation(pc.x, pc.y, pd.x, pd.y, pb.x, pb.y)
      if (o1 * o2 < 0 && o3 * o4 < 0) {
        crossings += 1
      }
    }
  }

  let overSystems = 0
  let straight = 0
  let diagonal = 0
  for (const [a, b, pa, pb] of segments) {
    const dx = pb.x - pa.x
    const dy = pb.y - pa.y
    const lengthSquared = dx * dx + dy * dy
    const covers = !lengthSquared || ids.some((id) => {
      if (id === a || id === b) {
        return false
      }

      const p = positions[id]
      const t = ((p.x - pa.x) * dx + (p.y - pa.y) * dy) / lengthSquared
      const cross = dx * (p.y - pa.y) - dy * (p.x - pa.x)

      return t > 0 && t < 1 && (cross * cross) / lengthSquared < markerRadius * markerRadius
    })

    if (covers) {
      overSystems += 1
    }

    const angle = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI
    if (angle < 3 || angle > 87) {
      straight += 1
    } else if (Math.abs(angle - 45) < 3) {
      diagonal += 1
    }
  }

  return {
    links: segments.length,
    crossings,
    overSystems,
    straight,
    diagonal,
    other: segments.length - straight - diagonal,
  }
}
