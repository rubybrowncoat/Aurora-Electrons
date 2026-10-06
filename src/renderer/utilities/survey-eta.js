// Days to finish a system's gravitational and geological survey work with the fleets in it.
// A fleet follows one order at a time, so a fleet with both sensors surveys one kind of target
// at a time: its time is split between the two. Fleets with one sensor work their own track in
// parallel. The time is the shortest one over every way of splitting the dual fleets' time, which
// is found by giving them to the gravitational track in order of how much better they are at it.
// Returns 0 with no work, null when some work has no fleet able to do it.
export const surveyDays = (gravPoints, geoPoints, fleets) => {
  if (!gravPoints && !geoPoints) {
    return 0
  }

  let gravOnly = 0
  let geoOnly = 0
  const dual = []

  fleets.forEach((fleet) => {
    if (fleet.gravRate > 0 && fleet.geoRate > 0) {
      dual.push(fleet)
    } else {
      gravOnly += fleet.gravRate
      geoOnly += fleet.geoRate
    }
  })

  if ((gravPoints && !gravOnly && !dual.length) || (geoPoints && !geoOnly && !dual.length)) {
    return null
  }

  dual.sort((a, b) => b.gravRate / b.geoRate - a.gravRate / a.geoRate)

  // Can both tracks finish within `days` if the dual fleets are split best?
  const feasible = (days) => {
    let gravNeed = Math.max(0, gravPoints / days - gravOnly)
    let geoSpare = geoOnly

    dual.forEach((fleet) => {
      const share = Math.min(1, gravNeed / fleet.gravRate)

      gravNeed -= share * fleet.gravRate
      geoSpare += (1 - share) * fleet.geoRate
    })

    return gravNeed <= 1e-9 && geoSpare * days >= geoPoints - 1e-9
  }

  // Both tracks done one after the other at the slowest positive rate is a safe upper bound.
  const rates = fleets.flatMap((fleet) => [fleet.gravRate, fleet.geoRate]).filter((rate) => rate > 0)
  let high = (gravPoints + geoPoints) / Math.min(...rates)
  let low = 0

  for (let step = 0; step < 80; step++) {
    const middle = (low + high) / 2

    if (feasible(middle)) {
      high = middle
    } else {
      low = middle
    }
  }

  return high
}
