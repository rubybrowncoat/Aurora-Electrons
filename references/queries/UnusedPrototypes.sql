-- unused prototype components not marked for research
SELECT
	sdc.Name
	,rt.Obsolete
	,sdc.Prototype	
	,*
FROM
	vw_const as c
inner JOIN
	FCT_RaceTech as rt on rt.RaceID = c.RaceID
inner JOIN
	FCT_TechSystem as ts on ts.RaceID = c.RaceID and ts.TechSystemID = rt.TechID
inner JOIN
	FCT_ShipDesignComponents as sdc on sdc.SDComponentID = rt.TechID --ts.TechSystemID
left JOIN
	FCT_ClassComponent as cc
on
	cc.ComponentID = sdc.SDComponentID
WHERE
	sdc.Prototype = 1	-- sdc.Prototype: 0 = not; 1 = not marked for research;	3 = marked for research
AND	cc.ComponentID is null
order by
	sdc.Name