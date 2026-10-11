// The game puts a newly found system this far from the one it was reached from, and no closer than this to any other.
export const GAME_SPACING = 140
const AROUND = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]

const clampToSpacing = (value) => Math.max(-GAME_SPACING, Math.min(GAME_SPACING, value))

// Systems the game never put on the map all sit at 0, 0. One of them keeps that place: the capital if it is there, else the one with the most links to placed systems (the race's home system, whose neighbours the game placed round it). Each other gets a place beside a linked system that has one, the way the game places a system it has just found: straight on past that system, away from the one it was reached from, else the first cell around it with no system within GAME_SPACING. Systems with no placed link go in a row under the map.
// `rows` are [{ id, Xcor, Ycor }], `saved` their places ({ id: { x, y } }) and `neighbours` the ids linked to each id. Returns the places with the unplaced systems moved, and the ids moved.
export const placeUnplaced = (rows, saved, neighbours, capitalId = null) => {
  const atOrigin = rows.filter((row) => !row.Xcor && !row.Ycor)

  if (atOrigin.length < 2) {
    return { positions: saved, unplaced: [] }
  }

  const placedLinks = (row) => (neighbours[row.id] || []).filter((other) => saved[other] && (saved[other].x || saved[other].y)).length
  const kept = atOrigin.find((row) => row.id === capitalId) || atOrigin.reduce((best, row) => (placedLinks(row) > placedLinks(best) ? row : best))
  const unplaced = atOrigin.filter((row) => row !== kept).map((row) => row.id)
  const waiting = new Set(unplaced)
  const positions = { ...saved }
  unplaced.forEach((id) => delete positions[id])

  const free = ([x, y]) => Object.values(positions).every((position) => Math.abs(position.x - x) >= GAME_SPACING || Math.abs(position.y - y) >= GAME_SPACING)
  let progress = true

  while (waiting.size && progress) {
    progress = false

    for (const id of waiting) {
      const anchor = (neighbours[id] || []).find((other) => positions[other])

      if (!anchor) {
        continue
      }

      const at = positions[anchor]
      const from = (neighbours[anchor] || []).find((other) => other !== id && positions[other])
      const spots = []

      if (from) {
        const dx = clampToSpacing(at.x - positions[from].x)
        const dy = clampToSpacing(at.y - positions[from].y)

        if (dx || dy) {
          spots.push([at.x + dx, at.y + dy])
        }
      }

      for (let ring = 1; ring <= 4; ring += 1) {
        AROUND.forEach(([ox, oy]) => spots.push([at.x + ox * GAME_SPACING * ring, at.y + oy * GAME_SPACING * ring]))
      }

      const [x, y] = spots.find(free) || spots[spots.length - 1]
      positions[id] = { x, y }
      waiting.delete(id)
      progress = true
    }
  }

  if (waiting.size) {
    const placed = Object.values(positions)
    const bottom = Math.max(0, ...placed.map((position) => position.y)) + 2 * GAME_SPACING
    let x = Math.min(0, ...placed.map((position) => position.x))

    waiting.forEach((id) => {
      positions[id] = { x, y: bottom }
      x += GAME_SPACING
    })
  }

  return { positions, unplaced }
}
