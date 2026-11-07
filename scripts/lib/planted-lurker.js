// The lurker design of the game made from a stored design of a fixture, for no save holds one (the played save, the shipped saves and the migrated save have none). The oracle is the game's own: the game's missile design adds 0.5 to the size, 0.5 to the cost and 0.5 of Boronide once when the Lurker Mode box is checked, and stores the flag. It is written out here with none of the constants of the rules, with the speed that follows from the larger size (the engine power over the size in HS, to 0.1 km/s, never over 270,000) and the range from the speed; every other figure of the row is the stored design's, which the stock fixtures reproduce.
//
// Returns { copy, design }: a copy of `fixture` and the design `id` of it, now a lurker. The fixture it is given is not changed.

const plantLurker = (fixture, id) => {
  const copy = JSON.parse(JSON.stringify(fixture))
  const design = copy.designs.find((entry) => entry.id === id)
  const { row } = design
  const size = row.Size + 0.5
  const speed = Math.min(270000, Math.round(copy.components[row.EngineID].power * row.NumEngines / (size / 20) * 10000) / 10)

  design.row = { ...row, Lurker: 1, Size: size, Cost: row.Cost + 0.5, Boronide: row.Boronide + 0.5, Speed: speed, MaxRange: speed * row.Endurance }

  return { copy, design }
}

module.exports = { plantLurker }
