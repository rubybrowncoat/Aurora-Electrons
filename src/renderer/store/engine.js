export const state = () => {
  return {
    selectedTonnage: 15000,
    selectedSpeed: 2000,
    selectedRange: 100,
    
    selectedEngine: 1,
    selectedFuelConsumption: 1,
    selectedThrustModifierRange: [0.5, 1],
    selectedEngineSize: 25,
    
    selectedJump: 1,
    selectedJumpEfficiency: 4,
    selectedSquadronSize: 1,
    selectedSquadronRadius: 1,

    selectedArmor: 1,
    selectedLayers: 1,
  }
}

export const mutations = {
  setSelectedTonnage(state, tonnage) {
    state.selectedTonnage = tonnage
  },
  setSelectedSpeed(state, speed) {
    state.selectedSpeed = speed
  },
  setSelectedRange(state, range) {
    state.selectedRange = range
  },
  
  setSelectedEngine(state, engine) {
    state.selectedEngine = engine
  },
  setSelectedFuelConsumption(state, fuelConsumption) {
    state.selectedFuelConsumption = fuelConsumption
  },
  setSelectedThrustModifierRange(state, thrustModifierRange) {
    state.selectedThrustModifierRange = thrustModifierRange
  },
  setSelectedEngineSize(state, engineSize) {
    state.selectedEngineSize = engineSize
  },
  
  setSelectedJump(state, jump) {
    state.selectedJump = jump
  },
  setSelectedJumpEfficiency(state, jumpEfficiency) {
    state.selectedJumpEfficiency = jumpEfficiency
  },
  setSelectedSquadronSize(state, squadronSize) {
    state.selectedSquadronSize = squadronSize
  },
  setSelectedSquadronRadius(state, squadronRadius) {
    state.selectedSquadronRadius = squadronRadius
  },

  setSelectedArmor(state, armor) {
    state.selectedArmor = armor
  },
  setSelectedLayers(state, layers) {
    state.selectedLayers = layers
  },
}
