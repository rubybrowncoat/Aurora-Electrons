with CTE_Options as 
(
	SELECT
		1 as CopyNACs						--copy the Naval Admin Command structure and configuration
		,1 as CopyResearch_ScienceOnly		--copy research completed (other than ship components, missiles, and ground unit classes), and use the required Instant Research Points
		,1 as CopyResearch_ShipComponents	--copy research completed for ship components, and use the required Instant Research Points
		,1 as CopyResearch_Missiles			--copy research completed for missiles, and use the required Instant Research Points
		,1 as CopyResearch_GroundUnits		--copy research completed for ground unit classes, and use the required Instant Research Points
		,0 as CopyShipDesigns				--copy any ship designs created (requires CopyResearch_ShipComponents = 1)
		,0 as CopyStartingShips				--copy any ships created (requires CopyShipDesigns = 1)
		....more such options...
)

--...the main script stuff...