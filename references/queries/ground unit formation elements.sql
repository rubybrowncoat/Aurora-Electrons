SELECT
	gufe.units , guc.size , gufe.FortificationLevel
	,gufe.units * guc.size * gufe.FortificationLevel
	,*
FROM
	FCT_GroundUnitFormationElement as gufe
inner JOIN
	FCT_GroundUnitClass as guc
on
	guc.GroundUnitClassID = gufe.ClassID
WHERE
	gufe.FormationID = 11404