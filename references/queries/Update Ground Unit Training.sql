SELECT
	*
FROM
	FCT_GroundUnitTrainingQueue as q
WHERE
	q.FormationTemplateID = 4164
	
	
update FCT_GroundUnitTrainingQueue
set FormationTemplateID = 4211
WHERE
	FormationTemplateID = 4164	
	
select FormationName, FormationName || ' - 2120' from
--update 
FCT_GroundUnitTrainingQueue
	--set FormationName = FormationName || ' - 2120'
	
WHERE
	FormationTemplateID = 4211