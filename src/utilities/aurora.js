import { convertDisplayBase } from "./generic"

import romanum from 'romanum'

export const systemBodyName = (body) => {
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
  const processedPopulation = prefix ? {
    SystemName: population[`${prefix}SystemName`] || population['SystemName'],
    SystemBodyID: population[`${prefix}SystemBodyID`] || population['SystemBodyID'],
    PlanetNumber: population[`${prefix}PlanetNumber`] || population['PlanetNumber'],
    OrbitNumber: population[`${prefix}OrbitNumber`] || population['OrbitNumber'],
    BodyClass: population[`${prefix}BodyClass`] || population['BodyClass'],
    SystemBodyName: population[`${prefix}SystemBodyName`] || population['SystemBodyName'],
    Component: population[`${prefix}Component`] || population['Component'],
    PopName: population[`${prefix}PopName`] || population['PopName'],
  } : population

  const populationBodyName = systemBodyName(processedPopulation)
  const systemBodyComponent = `${processedPopulation.SystemName}-${populationBodyName}` === processedPopulation.PopName || processedPopulation.SystemBodyName === processedPopulation.PopName 
    ? processedPopulation.SystemName 
    : `${processedPopulation.SystemName} ${populationBodyName}`

  return suppressSystem && processedPopulation.PopName.startsWith(processedPopulation.SystemName) 
    ? processedPopulation.PopName
    : `${systemBodyComponent} &mdash; ${processedPopulation.PopName}`
}
