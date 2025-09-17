import dayjs from 'dayjs'
import romanum from 'romanum'

import { convertDisplayBase } from './generic'

export const gameTime = (startYear, seconds) => {
  return dayjs(0).set('year', startYear).set('hour', 0).set('minute', 0).set('second', 0).add(seconds, 'second')
}

export const systemBodyName = body => {
  if (body.SystemBodyName) {
    return body.SystemBodyName
  }

  switch (body.BodyClass) {
  case 1: {
    return `${convertDisplayBase(body.Component, 26)} ${romanum.toNumeral(body.PlanetNumber)}`
  }
  case 2: {
    return `${convertDisplayBase(body.Component, 26)} ${romanum.toNumeral(body.PlanetNumber)}-${body.OrbitNumber}`
  }
  case 3: {
    return `Asteroid #${body.OrbitNumber}`
  }
  case 5: {
    return `Comet #${body.OrbitNumber}`
  }
  default: {
    return `System Body #${body.SystemBodyID}`
  }
  }
}

export const populationName = (population, prefix = '', suppressSystem = false) => {
  const processedPopulation = prefix
    ? {
      SystemName: population[`${prefix}SystemName`] || population.SystemName,
      SystemBodyID: population[`${prefix}SystemBodyID`] || population.SystemBodyID,
      PlanetNumber: population[`${prefix}PlanetNumber`] || population.PlanetNumber,
      OrbitNumber: population[`${prefix}OrbitNumber`] || population.OrbitNumber,
      BodyClass: population[`${prefix}BodyClass`] || population.BodyClass,
      SystemBodyName: population[`${prefix}SystemBodyName`] || population.SystemBodyName,
      Component: population[`${prefix}Component`] || population.Component,
      PopName: population[`${prefix}PopName`] || population.PopName,
    }
    : population

  const populationBodyName = systemBodyName(processedPopulation)
  const systemBodyComponent = `${processedPopulation.SystemName}-${populationBodyName}` === processedPopulation.PopName || processedPopulation.SystemBodyName === processedPopulation.PopName
    ? processedPopulation.SystemName
    : `${processedPopulation.SystemName} ${populationBodyName}`

  return suppressSystem && processedPopulation.PopName.startsWith(processedPopulation.SystemName)
    ? processedPopulation.PopName
    : `${systemBodyComponent} &mdash; ${processedPopulation.PopName}`
}

export const modelSystemBodyName = systemBody => {
  const normalizedModel = {
    SystemBodyID: systemBody.SystemBodyID,
    SystemBodyName: systemBody.SystemBodyNames.length ? systemBody.SystemBodyNames[0].Name : null,
    BodyClass: systemBody.BodyClass,
    Component: systemBody.Star.Component,
    PlanetNumber: systemBody.PlanetNumber,
    OrbitNumber: systemBody.OrbitNumber,
  }

  return systemBodyName(normalizedModel)
}

export const eventColorToRGBA = colorInteger => {
  colorInteger >>>= 0
  const b = colorInteger & 0xFF
  const g = (colorInteger & 0xFF00) >>> 8
  const r = (colorInteger & 0xFF0000) >>> 16
  const a = ((colorInteger & 0xFF000000) >>> 24) / 255

  return `rgba(${r}, ${g}, ${b}, ${a})`
}
