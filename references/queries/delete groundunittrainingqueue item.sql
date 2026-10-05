--select max(RaceID) as RaceID from FCT_Race where NPR = 0

SELECT
	*
FROM
	FCT_Population as p
inner JOIN
	FCT_GroundUnitTrainingQueue as gutq
on
	gutq.PopulationID = p.PopulationID
WHERE
	p.PopName = 'ADE-A10 SOR'

delete from FCT_GroundUnitTrainingQueue where PopulationID = 4342
	
	
