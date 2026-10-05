SELECT
	ts.Name
	,ts.DevelopCost
	,*
FROM
	FCT_TechSystem as ts
WHERE
	ts.RaceID = 0
AND
	ts.AutomaticResearch = 0
order by
	ts.TechTypeID
	,ts.DevelopCost